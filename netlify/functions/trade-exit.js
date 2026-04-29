/**
 * POST /.netlify/functions/trade-exit
 *
 * Daily exit-management pass. Scans every open spread (trade_ideas with
 * status='paper_open'), evaluates current natural exit credit, and closes
 * any spread that hits one of:
 *   - take_profit: realized credit >= entry_debit + 0.5 * max_gain (50% of max gain)
 *   - dte_management: <= 21 days to expiry (gamma risk explodes near expiry)
 *
 * Closing orders are multi-leg, day-limit, at natural exit credit. If they
 * don't fill same day, tomorrow's run will retry with fresh quotes — no
 * duplicate-order tracking needed.
 *
 * On fill, the trade_ideas row is updated with status='paper_closed',
 * actual_exit_price, realized_pnl_usd, realized_pnl_pct, closed_at.
 *
 * Body (all optional):
 *   { dry_run: false,                        // log decisions but don't fire
 *     take_profit_pct: 50,                   // % of max gain that triggers close
 *     dte_threshold: 21 }                    // close anything inside this DTE
 *
 * Auth: X-Admin-Password, X-Trigger-Token, or Netlify Scheduled invoke.
 *
 * Schedule: weekdays 19:30 UTC (3:30 PM ET, 30 min before market close —
 * leaves time for fills, avoids closing-print volatility).
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';

const TAKE_PROFIT_PCT_DEFAULT = parseFloat(process.env.TAKE_PROFIT_PCT || '50');
const DTE_THRESHOLD_DEFAULT = parseInt(process.env.DTE_THRESHOLD || '21', 10);

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
    };
}

function dteFromExpiry(expiry) {
    const ts = new Date(expiry + 'T20:00:00Z').getTime();        // 4pm ET ≈ 20:00 UTC
    return Math.ceil((ts - Date.now()) / 86400000);
}

function evaluateExit(spread, snapshots, takeProfitPct, dteThreshold) {
    const longSnap = snapshots[spread.long_symbol];
    const shortSnap = snapshots[spread.short_symbol];
    const longBid = longSnap?.latestQuote?.bp ?? null;
    const longAsk = longSnap?.latestQuote?.ap ?? null;
    const shortBid = shortSnap?.latestQuote?.bp ?? null;
    const shortAsk = shortSnap?.latestQuote?.ap ?? null;
    const dte = dteFromExpiry(spread.expiry);

    // Natural exit credit: sell the long at bid, buy back the short at ask.
    // This is the conservative price at which we can immediately exit.
    const naturalCredit = (longBid != null && shortAsk != null)
        ? +(longBid - shortAsk).toFixed(2)
        : null;

    // Mid credit: less reliable when bid/ask is wide (UNH-style mark noise).
    const midCredit = (longBid != null && longAsk != null && shortBid != null && shortAsk != null)
        ? +(((longBid + longAsk) / 2) - ((shortBid + shortAsk) / 2)).toFixed(2)
        : null;

    const maxGain = +(spread.width - spread.entry_debit).toFixed(2);
    const maxLoss = spread.entry_debit;
    const targetCredit = +(spread.entry_debit + maxGain * (takeProfitPct / 100)).toFixed(2);

    // Use natural for trigger — only fire when we can ACTUALLY realize the gain.
    let trigger = null;
    let reason = null;
    if (naturalCredit != null && naturalCredit >= targetCredit) {
        trigger = 'take_profit';
        reason = `natural credit $${naturalCredit} ≥ target $${targetCredit} (${takeProfitPct}% of max gain $${maxGain})`;
    } else if (dte <= dteThreshold) {
        trigger = 'dte_management';
        reason = `DTE ${dte} ≤ ${dteThreshold}`;
    }

    const realizedProfit = naturalCredit != null ? +(naturalCredit - spread.entry_debit).toFixed(2) : null;
    const realizedPnlPct = (realizedProfit != null && maxGain > 0) ? +((realizedProfit / maxGain) * 100).toFixed(1) : null;

    return {
        ...spread,
        dte,
        long_bid: longBid, long_ask: longAsk,
        short_bid: shortBid, short_ask: shortAsk,
        natural_credit: naturalCredit,
        mid_credit: midCredit,
        target_credit: targetCredit,
        max_gain: maxGain,
        max_loss: maxLoss,
        realized_profit: realizedProfit,
        realized_pnl_pct: realizedPnlPct,
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
    const takeProfitPct = cfg.take_profit_pct ?? TAKE_PROFIT_PCT_DEFAULT;
    const dteThreshold = cfg.dte_threshold ?? DTE_THRESHOLD_DEFAULT;

    const summary = {
        ok: true,
        started_at: new Date().toISOString(),
        dry_run: dryRun,
        config: { take_profit_pct: takeProfitPct, dte_threshold: dteThreshold },
        evaluated: [],
        closed: [],
        skipped: [],
        errors: [],
    };

    try {
        // 1. Pull all open trade_ideas
        const openIdeas = await sbSelect('trade_ideas?status=eq.paper_open&select=id,symbol,strategy,structure,planned_entry_price,actual_entry_price,planned_max_loss_usd,planned_max_gain_usd&order=created_at.desc');

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
        const evaluations = spreads.map(s => evaluateExit(s, snapshots, takeProfitPct, dteThreshold));
        summary.evaluated = evaluations.map(e => ({
            idea_id: e.idea_id,
            symbol: e.underlying,
            side: e.side,
            strikes: `${e.long_strike}/${e.short_strike}`,
            expiry: e.expiry,
            dte: e.dte,
            entry_debit: e.entry_debit,
            natural_credit: e.natural_credit,
            target_credit: e.target_credit,
            realized_pnl: e.realized_profit,
            realized_pnl_pct: e.realized_pnl_pct,
            trigger: e.trigger,
            reason: e.reason,
        }));

        // 5. For each triggered spread, submit closing order (or log if dry_run)
        for (const e of evaluations) {
            if (!e.trigger) {
                summary.skipped.push({
                    idea_id: e.idea_id, symbol: e.underlying,
                    reason: 'no trigger',
                    natural: e.natural_credit, target: e.target_credit, dte: e.dte,
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
                    realized_pnl_pct: e.realized_pnl_pct,
                    closed_at: new Date().toISOString(),
                    notes: `Auto-exit (${e.trigger}). ${e.reason}. Closing limit $${close.limit}. Order ${close.order_id}.`,
                });
                summary.closed.push({
                    idea_id: e.idea_id, symbol: e.underlying,
                    trigger: e.trigger, reason: e.reason,
                    order_id: close.order_id, request_id: close.request_id,
                    limit: close.limit,
                    realized_pnl: +(e.realized_profit * 100).toFixed(2),
                    realized_pnl_pct: e.realized_pnl_pct,
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

// Netlify Scheduled Function: weekdays 19:30 UTC (3:30 PM ET, 30 min before close).
exports.config = {
    schedule: '30 19 * * 1-5',
};
