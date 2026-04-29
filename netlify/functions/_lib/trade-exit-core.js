/**
 * Shared core for trade-exit. Used by:
 *   - netlify/functions/trade-exit.js  (HTTP / scheduled fn wrapper)
 *   - scripts/trade-exit-runner.js     (Mac mini cron, every 30 min)
 *
 * Reads env: SUPABASE_SERVICE_ROLE_KEY, ALPACA_KEY_ID, ALPACA_SECRET_KEY, ALPACA_BASE_URL.
 *
 * The leading underscore on `_lib` tells Netlify NOT to deploy this directory
 * as its own function — it's just a shared module imported by the real fn.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const DATA_BASE = 'https://data.alpaca.markets';

const NEAR_MAX_PCT_DEFAULT = parseFloat(process.env.NEAR_MAX_PCT || '90');
const ARM_TRAIL_PCT_DEFAULT = parseFloat(process.env.ARM_TRAIL_PCT || '50');
const DTE_THRESHOLD_DEFAULT = parseInt(process.env.DTE_THRESHOLD || '21', 10);

function trailPctForPeak(peakPct) {
    if (peakPct >= 85) return 5;
    if (peakPct >= 75) return 7;
    return 10;
}

const sbHeaders = () => ({
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
});
const alpacaHeaders = () => ({
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
});

async function alpaca(method, base, path, body) {
    const init = { method, headers: alpacaHeaders() };
    if (body) init.body = JSON.stringify(body);
    const r = await fetch(`${base}${path}`, init);
    const requestId = r.headers.get('x-request-id');
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!r.ok) {
        const e = new Error(`${method} ${path} ${r.status}: ${typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`);
        e.requestId = requestId;
        e.status = r.status;
        e.body = parsed;
        throw e;
    }
    return { body: parsed, requestId };
}

async function fetchSnapshots(syms) {
    if (!syms.length) return {};
    const out = {};
    for (let i = 0; i < syms.length; i += 50) {
        const chunk = syms.slice(i, i + 50);
        const params = new URLSearchParams({ symbols: chunk.join(','), feed: 'indicative' });
        try {
            const { body: j } = await alpaca('GET', DATA_BASE, `/v1beta1/options/snapshots?${params}`);
            if (j.snapshots) Object.assign(out, j.snapshots);
        } catch { /* skip chunk on failure */ }
    }
    return out;
}

async function sbSelect(path) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`sb select ${path}: ${r.status}`);
    return r.json();
}

async function sbUpdate(table, id, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`sb update ${table}: ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sbInsert(table, row, prefer = 'return=minimal') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', headers: { ...sbHeaders(), Prefer: prefer }, body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`sb insert ${table}: ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return prefer.includes('representation') ? r.json() : null;
}

// ── Spread analysis ─────────────────────────────────────────────────────────

function parseOccSymbol(occ) {
    const m = occ.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    if (!m) return null;
    const [, underlying, yy, mm, dd, side, strikeStr] = m;
    return {
        underlying,
        expiry: `20${yy}-${mm}-${dd}`,
        side: side === 'C' ? 'call' : 'put',
        strike: parseInt(strikeStr, 10) / 1000,
    };
}

function classifyIdea(idea) {
    const legs = idea.structure?.legs || [];
    if (legs.length !== 2) return null;
    const longLeg = legs.find(l => l.side === 'buy' || l.position_intent === 'buy_to_open');
    const shortLeg = legs.find(l => l.side === 'sell' || l.position_intent === 'sell_to_open');
    if (!longLeg || !shortLeg) return null;
    const longInfo = parseOccSymbol(longLeg.symbol);
    const shortInfo = parseOccSymbol(shortLeg.symbol);
    if (!longInfo || !shortInfo) return null;
    if (longInfo.expiry !== shortInfo.expiry) return null;
    return {
        idea_id: idea.id,
        underlying: longInfo.underlying,
        side: longInfo.side,
        expiry: longInfo.expiry,
        long_symbol: longLeg.symbol,
        long_strike: longInfo.strike,
        short_symbol: shortLeg.symbol,
        short_strike: shortInfo.strike,
        width: Math.abs(longInfo.strike - shortInfo.strike),
        entry_debit: parseFloat(idea.planned_entry_price || idea.actual_entry_price || idea.structure?.limit_price || '0'),
        prior_peak_credit: idea.peak_credit != null ? parseFloat(idea.peak_credit) : null,
    };
}

function dteFromExpiry(expiry) {
    const ts = new Date(expiry + 'T20:00:00Z').getTime();
    return Math.ceil((ts - Date.now()) / 86400000);
}

function evaluateExit(spread, snapshots, opts) {
    const { nearMaxPct, armTrailPct, dteThreshold } = opts;
    const longSnap = snapshots[spread.long_symbol];
    const shortSnap = snapshots[spread.short_symbol];
    const longBid = longSnap?.latestQuote?.bp ?? null;
    const longAsk = longSnap?.latestQuote?.ap ?? null;
    const shortBid = shortSnap?.latestQuote?.bp ?? null;
    const shortAsk = shortSnap?.latestQuote?.ap ?? null;
    const dte = dteFromExpiry(spread.expiry);

    const naturalCredit = (longBid != null && shortAsk != null)
        ? +(longBid - shortAsk).toFixed(2) : null;
    const midCredit = (longBid != null && longAsk != null && shortBid != null && shortAsk != null)
        ? +(((longBid + longAsk) / 2) - ((shortBid + shortAsk) / 2)).toFixed(2) : null;

    const maxGain = +(spread.width - spread.entry_debit).toFixed(2);
    const maxLoss = spread.entry_debit;
    const priorPeak = spread.prior_peak_credit;
    const updatedPeak = naturalCredit != null
        ? +Math.max(priorPeak ?? naturalCredit, naturalCredit).toFixed(2) : priorPeak;

    const currentPct = (naturalCredit != null && maxGain > 0)
        ? +(((naturalCredit - spread.entry_debit) / maxGain) * 100).toFixed(1) : null;
    const peakPct = (updatedPeak != null && maxGain > 0)
        ? +(((updatedPeak - spread.entry_debit) / maxGain) * 100).toFixed(1) : null;
    const drawdownFromPeak = (naturalCredit != null && updatedPeak != null && updatedPeak > 0)
        ? +(((updatedPeak - naturalCredit) / updatedPeak) * 100).toFixed(1) : null;

    let trigger = null, reason = null;
    if (currentPct != null && currentPct >= nearMaxPct) {
        trigger = 'near_max';
        reason = `current ${currentPct}% of max gain ≥ ${nearMaxPct}%`;
    } else if (peakPct != null && peakPct >= armTrailPct && drawdownFromPeak != null) {
        const trailPct = trailPctForPeak(peakPct);
        if (drawdownFromPeak >= trailPct) {
            trigger = 'trailing_stop';
            reason = `peak ${peakPct}% (credit $${updatedPeak}); drew down ${drawdownFromPeak}% ≥ ${trailPct}% trail`;
        }
    }
    if (!trigger && dte <= dteThreshold) {
        trigger = 'dte_management';
        reason = `DTE ${dte} ≤ ${dteThreshold}`;
    }

    const realizedProfit = naturalCredit != null ? +(naturalCredit - spread.entry_debit).toFixed(2) : null;

    return {
        ...spread, dte,
        long_bid: longBid, long_ask: longAsk, short_bid: shortBid, short_ask: shortAsk,
        natural_credit: naturalCredit, mid_credit: midCredit,
        updated_peak: updatedPeak,
        peak_pct: peakPct, current_pct: currentPct,
        drawdown_from_peak: drawdownFromPeak,
        max_gain: maxGain, max_loss: maxLoss,
        realized_profit: realizedProfit,
        trigger, reason,
    };
}

async function submitClose(spread) {
    const limitPrice = spread.natural_credit;
    if (limitPrice == null || limitPrice <= 0) {
        throw new Error(`bad limit price ${limitPrice}`);
    }
    const tradingBase = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
    const orderBody = {
        order_class: 'mleg', type: 'limit',
        limit_price: String(limitPrice), time_in_force: 'day', qty: '1',
        legs: [
            { symbol: spread.long_symbol,  side: 'sell', ratio_qty: '1', position_intent: 'sell_to_close' },
            { symbol: spread.short_symbol, side: 'buy',  ratio_qty: '1', position_intent: 'buy_to_close' },
        ],
    };
    const start = Date.now();
    const { body, requestId } = await alpaca('POST', tradingBase, '/v2/orders', orderBody);
    sbInsert('alpaca_api_log', {
        method: 'POST', path: '/v2/orders',
        status_code: 200, request_id: requestId,
        duration_ms: Date.now() - start, error: null,
        related_idea_id: spread.idea_id,
    }).catch(() => {});
    return { order_id: body.id, request_id: requestId, limit: limitPrice };
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Run one trade-exit pass. Returns a summary suitable for logging or HTTP response.
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @param {number} opts.nearMaxPct
 * @param {number} opts.armTrailPct
 * @param {number} opts.dteThreshold
 * @param {string} opts.source                    'netlify-scheduled' | 'mac-mini-cron' | 'manual'
 */
async function runTradeExit(opts = {}) {
    const dryRun = !!opts.dryRun;
    const nearMaxPct = opts.nearMaxPct ?? NEAR_MAX_PCT_DEFAULT;
    const armTrailPct = opts.armTrailPct ?? ARM_TRAIL_PCT_DEFAULT;
    const dteThreshold = opts.dteThreshold ?? DTE_THRESHOLD_DEFAULT;
    const source = opts.source || 'unknown';

    const summary = {
        ok: true,
        started_at: new Date().toISOString(),
        source,
        dry_run: dryRun,
        config: { near_max_pct: nearMaxPct, arm_trail_pct: armTrailPct, dte_threshold: dteThreshold },
        evaluated: [], peak_updates: 0, closed: [], skipped: [], errors: [],
    };

    try {
        const openIdeas = await sbSelect('trade_ideas?status=eq.paper_open&select=id,symbol,strategy,structure,planned_entry_price,actual_entry_price,planned_max_loss_usd,planned_max_gain_usd,peak_credit&order=created_at.desc');
        const spreads = openIdeas.map(classifyIdea).filter(Boolean);
        if (spreads.length === 0) {
            summary.note = 'no open paper spreads to evaluate';
            return summary;
        }

        const allLegSymbols = [...new Set(spreads.flatMap(s => [s.long_symbol, s.short_symbol]))];
        const snapshots = await fetchSnapshots(allLegSymbols);

        const evaluations = spreads.map(s => evaluateExit(s, snapshots, { nearMaxPct, armTrailPct, dteThreshold }));
        summary.evaluated = evaluations.map(e => ({
            idea_id: e.idea_id, symbol: e.underlying, side: e.side,
            strikes: `${e.long_strike}/${e.short_strike}`, expiry: e.expiry, dte: e.dte,
            entry_debit: e.entry_debit, natural_credit: e.natural_credit,
            current_pct: e.current_pct, peak_credit: e.updated_peak, peak_pct: e.peak_pct,
            drawdown_from_peak: e.drawdown_from_peak, realized_pnl: e.realized_profit,
            trigger: e.trigger, reason: e.reason,
        }));

        // Persist peak_credit advances
        for (const e of evaluations) {
            const newPeak = e.updated_peak;
            const oldPeak = e.prior_peak_credit;
            if (newPeak != null && (oldPeak == null || newPeak > oldPeak)) {
                if (!dryRun) {
                    await sbUpdate('trade_ideas', e.idea_id, { peak_credit: newPeak }).catch(err => {
                        summary.errors.push({ idea_id: e.idea_id, where: 'peak_update', error: err.message });
                    });
                }
                summary.peak_updates++;
            }
        }

        for (const e of evaluations) {
            if (!e.trigger) {
                summary.skipped.push({
                    idea_id: e.idea_id, symbol: e.underlying, reason: 'no trigger',
                    current_pct: e.current_pct, peak_pct: e.peak_pct,
                    drawdown_from_peak: e.drawdown_from_peak, dte: e.dte,
                });
                continue;
            }
            if (dryRun) {
                summary.closed.push({
                    idea_id: e.idea_id, symbol: e.underlying,
                    trigger: e.trigger, reason: e.reason,
                    would_submit: { limit_price: e.natural_credit },
                });
                continue;
            }
            try {
                const close = await submitClose(e);
                await sbUpdate('trade_ideas', e.idea_id, {
                    status: 'paper_closed',
                    actual_exit_price: e.natural_credit,
                    realized_pnl_usd: +(e.realized_profit * 100).toFixed(2),
                    realized_pnl_pct: e.current_pct,
                    closed_at: new Date().toISOString(),
                    peak_credit: e.updated_peak,
                    notes: `Auto-exit (${e.trigger}). ${e.reason}. Limit $${close.limit}. Order ${close.order_id}.`,
                });
                summary.closed.push({
                    idea_id: e.idea_id, symbol: e.underlying,
                    trigger: e.trigger, reason: e.reason,
                    order_id: close.order_id, request_id: close.request_id,
                    limit: close.limit,
                    realized_pnl: +(e.realized_profit * 100).toFixed(2),
                    current_pct: e.current_pct, peak_pct: e.peak_pct,
                });
            } catch (err) {
                summary.errors.push({ idea_id: e.idea_id, symbol: e.underlying, error: err.message });
            }
        }

        summary.evaluated_count = summary.evaluated.length;
        summary.closed_count = summary.closed.length;
        summary.skipped_count = summary.skipped.length;
        summary.completed_at = new Date().toISOString();
        return summary;
    } catch (err) {
        summary.ok = false;
        summary.error = err.message;
        summary.completed_at = new Date().toISOString();
        return summary;
    }
}

/**
 * Record a heartbeat row in automation_runs so we know the scheduler is alive.
 * Best-effort — failures are logged but don't break the caller.
 */
async function recordRun(name, source, summary) {
    try {
        await sbInsert('automation_runs', {
            name,
            source,
            status: summary.ok ? (summary.error ? 'errored' : 'ok') : 'errored',
            started_at: summary.started_at,
            completed_at: summary.completed_at || new Date().toISOString(),
            summary,
        });
    } catch (err) {
        console.warn(`automation_runs insert failed: ${err.message}`);
    }
}

module.exports = { runTradeExit, recordRun };
