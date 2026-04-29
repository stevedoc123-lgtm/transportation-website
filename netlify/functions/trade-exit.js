/**
 * POST /.netlify/functions/trade-exit
 *
 * Hourly exit-management pass with trailing-stop logic. Scans every open
 * spread (trade_ideas with status='paper_open'), evaluates current natural
 * exit credit, and decides whether to close.
 *
 * State machine per spread (current_pct = % of max gain currently realized;
 * peak_pct = highest % of max gain ever seen since opening):
 *   - current_pct >= 90:                       close (near_max — marginal upside left)
 *   - peak_pct >= 50, drawdown >= trail_pct:   close (trailing_stop — locking in)
 *   - dte <= 21:                               close (dte_management — gamma risk)
 *   - else:                                    hold
 *
 * Trail tightness scales with how good the peak got:
 *   peak_pct 50–75%:   trail = 10%   (loose; let a hot move keep running)
 *   peak_pct 75–85%:   trail = 7%
 *   peak_pct 85%+ :    trail = 5%    (tight; protect the gain)
 *
 * Every run updates trade_ideas.peak_credit so the trail follows the price up.
 *
 * Closing orders are multi-leg, day-limit, at natural exit credit. If unfilled
 * same day, the next hourly run retries with fresh quotes.
 *
 * Body (all optional):
 *   { dry_run: false,
 *     near_max_pct: 90,         // close outright at this % of max gain
 *     arm_trail_pct: 50,        // peak must hit this % before trailing arms
 *     dte_threshold: 21 }
 *
 * Auth: X-Admin-Password, X-Trigger-Token, or Netlify Scheduled invoke.
 *
 * Schedule: every hour at :00, weekdays 14:00–19:00 UTC (10am–3pm ET).
 * Six runs per market day; covers most of cash session.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';

const NEAR_MAX_PCT_DEFAULT = parseFloat(process.env.NEAR_MAX_PCT || '90');
const ARM_TRAIL_PCT_DEFAULT = parseFloat(process.env.ARM_TRAIL_PCT || '50');
const DTE_THRESHOLD_DEFAULT = parseInt(process.env.DTE_THRESHOLD || '21', 10);

// Trail tightness as a function of peak profit: looser when peak is just
// getting going, tighter as we approach max gain.
function trailPctForPeak(peakPct) {
    if (peakPct >= 85) return 5;
    if (peakPct >= 75) return 7;
    return 10;                                  // peak 50–75
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
    // e.g. AAPL260522P00270000 → { underlying: 'AAPL', expiry: '2026-05-22', side: 'put', strike: 270 }
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
    // Pull long/short legs from structure
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
        side: longInfo.side,                                  // 'put' or 'call' debit spread
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
    const ts = new Date(expiry + 'T20:00:00Z').getTime();        // 4pm ET ≈ 20:00 UTC
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

    // Natural exit credit = sell long at bid, buy short back at ask.
    const naturalCredit = (longBid != null && shortAsk != null)
        ? +(longBid - shortAsk).toFixed(2)
        : null;
    const midCredit = (longBid != null && longAsk != null && shortBid != null && shortAsk != null)
        ? +(((longBid + longAsk) / 2) - ((shortBid + shortAsk) / 2)).toFixed(2)
        : null;

    const maxGain = +(spread.width - spread.entry_debit).toFixed(2);
    const maxLoss = spread.entry_debit;

    // Update peak: highest natural credit ever seen for this spread.
    // If we have no quote this run, fall back to the prior peak.
    const priorPeak = spread.prior_peak_credit;
    const updatedPeak = naturalCredit != null
        ? +Math.max(priorPeak ?? naturalCredit, naturalCredit).toFixed(2)
        : priorPeak;

    const currentPct = (naturalCredit != null && maxGain > 0)
        ? +(((naturalCredit - spread.entry_debit) / maxGain) * 100).toFixed(1)
        : null;
    const peakPct = (updatedPeak != null && maxGain > 0)
        ? +(((updatedPeak - spread.entry_debit) / maxGain) * 100).toFixed(1)
        : null;
    const drawdownFromPeak = (naturalCredit != null && updatedPeak != null && updatedPeak > 0)
        ? +(((updatedPeak - naturalCredit) / updatedPeak) * 100).toFixed(1)
        : null;

    // ── State machine ──
    let trigger = null, reason = null;

    if (currentPct != null && currentPct >= nearMaxPct) {
        trigger = 'near_max';
        reason = `current ${currentPct}% of max gain ≥ ${nearMaxPct}% — minimal upside left`;
    } else if (peakPct != null && peakPct >= armTrailPct && drawdownFromPeak != null) {
        const trailPct = trailPctForPeak(peakPct);
        if (drawdownFromPeak >= trailPct) {
            trigger = 'trailing_stop';
            reason = `peak hit ${peakPct}% of max gain (credit $${updatedPeak}); current drew down ${drawdownFromPeak}% ≥ ${trailPct}% trail — locking in`;
        }
    }
    if (!trigger && dte <= dteThreshold) {
        trigger = 'dte_management';
        reason = `DTE ${dte} ≤ ${dteThreshold} — closing for gamma management`;
    }

    const realizedProfit = naturalCredit != null ? +(naturalCredit - spread.entry_debit).toFixed(2) : null;

    return {
        ...spread,
        dte,
        long_bid: longBid, long_ask: longAsk,
        short_bid: shortBid, short_ask: shortAsk,
        natural_credit: naturalCredit,
        mid_credit: midCredit,
        updated_peak: updatedPeak,
        peak_pct: peakPct,
        current_pct: currentPct,
        drawdown_from_peak: drawdownFromPeak,
        max_gain: maxGain,
        max_loss: maxLoss,
        realized_profit: realizedProfit,
        trigger,
        reason,
    };
}

async function submitClose(spread) {
    // Multi-leg sell-to-close (long) + buy-to-close (short) at natural credit.
    const limitPrice = spread.natural_credit;
    if (limitPrice == null || limitPrice <= 0) {
        throw new Error(`bad limit price ${limitPrice}`);
    }
    const orderBody = {
        order_class: 'mleg', type: 'limit',
        limit_price: String(limitPrice), time_in_force: 'day', qty: '1',
        legs: [
            { symbol: spread.long_symbol,  side: 'sell', ratio_qty: '1', position_intent: 'sell_to_close' },
            { symbol: spread.short_symbol, side: 'buy',  ratio_qty: '1', position_intent: 'buy_to_close' },
        ],
    };
    const start = Date.now();
    const { body, requestId } = await alpaca('POST', TRADING_BASE, '/v2/orders', orderBody);
    sbInsert('alpaca_api_log', {
        method: 'POST', path: '/v2/orders',
        status_code: 200, request_id: requestId,
        duration_ms: Date.now() - start, error: null,
        related_idea_id: spread.idea_id,
    }).catch(() => {});
    return { order_id: body.id, request_id: requestId, limit: limitPrice };
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const expectedAdmin = process.env.ADMIN_PASSWORD;
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const isScheduled = (event.headers['user-agent'] || '').includes('Netlify Functions Scheduled');
    const ok = isScheduled
        || (expectedAdmin && adminPw === expectedAdmin)
        || (expectedTrigger && trigger === expectedTrigger);
    if (!ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

    let cfg = {};
    try { cfg = event.body ? JSON.parse(event.body) : {}; } catch {}
    const dryRun = !!cfg.dry_run;
    const nearMaxPct = cfg.near_max_pct ?? NEAR_MAX_PCT_DEFAULT;
    const armTrailPct = cfg.arm_trail_pct ?? ARM_TRAIL_PCT_DEFAULT;
    const dteThreshold = cfg.dte_threshold ?? DTE_THRESHOLD_DEFAULT;

    const summary = {
        ok: true,
        started_at: new Date().toISOString(),
        dry_run: dryRun,
        config: { near_max_pct: nearMaxPct, arm_trail_pct: armTrailPct, dte_threshold: dteThreshold },
        evaluated: [],
        peak_updates: 0,
        closed: [],
        skipped: [],
        errors: [],
    };

    try {
        // 1. Pull all open trade_ideas (include peak_credit for trailing logic)
        const openIdeas = await sbSelect('trade_ideas?status=eq.paper_open&select=id,symbol,strategy,structure,planned_entry_price,actual_entry_price,planned_max_loss_usd,planned_max_gain_usd,peak_credit&order=created_at.desc');

        // 2. Classify each into a spread shape
        const spreads = openIdeas.map(classifyIdea).filter(Boolean);
        if (spreads.length === 0) {
            summary.note = 'no open paper spreads to evaluate';
            return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary, null, 2) };
        }

        // 3. Batch-fetch quotes for every leg in one pass
        const allLegSymbols = [...new Set(spreads.flatMap(s => [s.long_symbol, s.short_symbol]))];
        const snapshots = await fetchSnapshots(allLegSymbols);

        // 4. Evaluate each spread
        const evaluations = spreads.map(s => evaluateExit(s, snapshots, { nearMaxPct, armTrailPct, dteThreshold }));
        summary.evaluated = evaluations.map(e => ({
            idea_id: e.idea_id,
            symbol: e.underlying,
            side: e.side,
            strikes: `${e.long_strike}/${e.short_strike}`,
            expiry: e.expiry,
            dte: e.dte,
            entry_debit: e.entry_debit,
            natural_credit: e.natural_credit,
            current_pct: e.current_pct,
            peak_credit: e.updated_peak,
            peak_pct: e.peak_pct,
            drawdown_from_peak: e.drawdown_from_peak,
            realized_pnl: e.realized_profit,
            trigger: e.trigger,
            reason: e.reason,
        }));

        // 4b. Persist peak_credit for every spread that has a fresh quote — even
        //     ones we're not closing. This is what lets the trail follow the price up.
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

        // 5. For each triggered spread, submit closing order (or log if dry_run)
        for (const e of evaluations) {
            if (!e.trigger) {
                summary.skipped.push({
                    idea_id: e.idea_id, symbol: e.underlying,
                    reason: 'no trigger',
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
                // Mark trade_ideas as closing (not yet filled; fill confirms async).
                // We optimistically record realized_pnl based on natural credit; if the
                // actual fill is different, a follow-up sync job could reconcile.
                await sbUpdate('trade_ideas', e.idea_id, {
                    status: 'paper_closed',
                    actual_exit_price: e.natural_credit,
                    realized_pnl_usd: +(e.realized_profit * 100).toFixed(2),  // dollars (×100 per spread contract)
                    realized_pnl_pct: e.current_pct,
                    closed_at: new Date().toISOString(),
                    peak_credit: e.updated_peak,
                    notes: `Auto-exit (${e.trigger}). ${e.reason}. Closing limit $${close.limit}. Order ${close.order_id}.`,
                });
                summary.closed.push({
                    idea_id: e.idea_id, symbol: e.underlying,
                    trigger: e.trigger, reason: e.reason,
                    order_id: close.order_id, request_id: close.request_id,
                    limit: close.limit,
                    realized_pnl: +(e.realized_profit * 100).toFixed(2),
                    current_pct: e.current_pct,
                    peak_pct: e.peak_pct,
                });
            } catch (err) {
                summary.errors.push({ idea_id: e.idea_id, symbol: e.underlying, error: err.message });
            }
        }

        summary.evaluated_count = summary.evaluated.length;
        summary.closed_count = summary.closed.length;
        summary.skipped_count = summary.skipped.length;

        return {
            statusCode: 200,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify(summary, null, 2),
        };
    } catch (err) {
        console.error('trade-exit error', err);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};

// Netlify Scheduled Function: every hour at :00, weekdays 14:00–19:00 UTC.
// That's 10am, 11am, 12pm, 1pm, 2pm, 3pm ET — 6 runs per market day.
// 10am avoids the noisy first 30 min of the open; 3pm gives time for the last
// fill to settle before close.
exports.config = {
    schedule: '0 14-19 * * 1-5',
};
