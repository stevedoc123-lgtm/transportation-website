/**
 * POST /.netlify/functions/trade-cycle
 *
 * Autonomous trading pipeline. Runs the screener (or uses recent ideas),
 * designs a fillable defined-risk spread within the $125 cap for each
 * top setup, fires at natural-fill + buffer, logs to trade_ideas.
 *
 * Body (all optional):
 *   { run_screener: true,                 // run screener first (default true)
 *     max_bearish: 2,                     // up to N bearish trades (default 2)
 *     max_bullish: 1,                     // up to N bullish trades (default 1)
 *     dry_run: false }                    // if true, design but don't fire
 *
 * Auth: X-Admin-Password or X-Trigger-Token, OR — if invoked as a
 * Netlify Scheduled Function — implicit (event.headers.user-agent
 * starts with 'Netlify Functions Scheduled Job').
 *
 * Hard guardrails:
 *   - $125 max loss per trade (server-validated downstream too)
 *   - Skip symbols we already have positions on
 *   - Stop if MAX_OPEN_POSITIONS reached (default 8)
 *   - Stop if MAX_NEW_TRADES_PER_DAY reached (default 4)
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';
const MAX_LOSS_PER_TRADE = parseFloat(process.env.MAX_LOSS_PER_TRADE || '125');
const MAX_OPEN_POSITIONS = parseInt(process.env.MAX_OPEN_POSITIONS || '8', 10);
const MAX_NEW_TRADES_PER_DAY = parseInt(process.env.MAX_NEW_TRADES_PER_DAY || '4', 10);
const FILL_BUFFER = parseFloat(process.env.FILL_BUFFER || '0.05'); // cents added to natural for reliable fill

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

async function alpacaGET(base, path) {
    const r = await fetch(`${base}${path}`, { headers: alpacaHeaders() });
    if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
}

async function getUnderlyingPrice(symbol) {
    const j = await alpacaGET(DATA_BASE, `/v2/stocks/${symbol}/snapshot?feed=iex`);
    if (j.latestTrade?.p) return j.latestTrade.p;
    if (j.latestQuote?.bp && j.latestQuote?.ap) return (j.latestQuote.bp + j.latestQuote.ap) / 2;
    if (j.dailyBar?.c) return j.dailyBar.c;
    if (j.prevDailyBar?.c) return j.prevDailyBar.c;
    throw new Error(`no price for ${symbol}`);
}

async function listContracts({ symbol, side, expGte, expLte, strikeMin, strikeMax }) {
    const params = new URLSearchParams({
        underlying_symbols: symbol, type: side, status: 'active',
        expiration_date_gte: expGte, expiration_date_lte: expLte,
        strike_price_gte: String(strikeMin), strike_price_lte: String(strikeMax),
        limit: '200',
    });
    let token = null, all = [];
    for (let i = 0; i < 5; i++) {
        if (token) params.set('page_token', token);
        const j = await alpacaGET(TRADING_BASE, `/v2/options/contracts?${params}`);
        if (j.option_contracts) all.push(...j.option_contracts);
        token = j.next_page_token;
        if (!token) break;
    }
    return all;
}

async function fetchSnapshots(syms) {
    if (!syms.length) return {};
    const out = {};
    for (let i = 0; i < syms.length; i += 50) {
        const chunk = syms.slice(i, i + 50);
        const params = new URLSearchParams({ symbols: chunk.join(','), feed: 'indicative' });
        try {
            const j = await alpacaGET(DATA_BASE, `/v1beta1/options/snapshots?${params}`);
            if (j.snapshots) Object.assign(out, j.snapshots);
        } catch { /* skip chunk on failure */ }
    }
    return out;
}

/**
 * Find the best fillable defined-risk vertical spread.
 * Returns { legs, limit_price, max_loss, max_gain, breakeven, long_strike, short_strike, expiry, dte } or null.
 *
 * For puts: long higher strike, short lower strike (debit spread).
 * For calls: long lower strike, short higher strike (debit spread).
 * Picks the closest-to-money spread that fills naturally within MAX_LOSS_PER_TRADE.
 */
async function designSpread({ symbol, side, dteMin = 21, dteMax = 35, capUsd = MAX_LOSS_PER_TRADE - 5 }) {
    const spot = await getUnderlyingPrice(symbol);
    const today = new Date();
    const fmt = d => d.toISOString().split('T')[0];
    const expGte = fmt(new Date(today.getTime() + dteMin * 86400000));
    const expLte = fmt(new Date(today.getTime() + dteMax * 86400000));
    // For puts, scan strikes 0–25% below spot. For calls, 0–15% above (calls run hot near ATM).
    const strikeMin = side === 'put' ? Math.floor(spot * 0.75) : Math.floor(spot * 0.99);
    const strikeMax = side === 'put' ? Math.ceil(spot * 1.01) : Math.ceil(spot * 1.15);

    const contracts = await listContracts({ symbol, side, expGte, expLte, strikeMin, strikeMax });
    if (!contracts.length) return null;
    const snapshots = await fetchSnapshots(contracts.map(c => c.symbol));

    const enriched = contracts.map(c => {
        const q = snapshots[c.symbol]?.latestQuote;
        return {
            symbol: c.symbol,
            strike: parseFloat(c.strike_price),
            expiry: c.expiration_date,
            bid: q?.bp ?? null,
            ask: q?.ap ?? null,
            oi: parseInt(c.open_interest || '0', 10),
        };
    }).filter(c => c.bid != null && c.ask != null);

    // Group by expiry; iterate widths 5 and 10
    const byExp = {};
    for (const c of enriched) (byExp[c.expiry] ||= []).push(c);

    let best = null;
    for (const exp of Object.keys(byExp).sort()) {
        const cs = byExp[exp].sort((a, b) => a.strike - b.strike);
        const dte = Math.round((new Date(exp + 'T16:00:00Z') - today) / 86400000);
        for (const long of cs) {
            for (const short of cs) {
                const isPutSpread = side === 'put' && short.strike < long.strike;
                const isCallSpread = side === 'call' && short.strike > long.strike;
                if (!isPutSpread && !isCallSpread) continue;
                const width = Math.abs(long.strike - short.strike);
                if (![3, 5, 10].includes(width)) continue;
                // Skip strikes that aren't OTM enough (puts: long below spot; calls: long above spot)
                if (side === 'put' && long.strike > spot * 1.0) continue;
                if (side === 'call' && long.strike < spot * 1.0) continue;
                // Natural fill = long_ask - short_bid (always positive for a debit spread)
                const natural = long.ask - short.bid;
                if (natural <= 0) continue;
                const maxLoss = natural * 100;
                if (maxLoss > capUsd) continue;
                if (long.oi < 5 || short.oi < 5) continue; // need *some* liquidity

                // Score: prefer close-to-money (smaller distance from spot to long strike, normalized)
                const dist = side === 'put' ? (spot - long.strike) / spot : (long.strike - spot) / spot;
                // Penalize very deep OTM (> 15%) and too-wide bid/ask
                const score = -dist - (Math.abs(long.ask - long.bid) / Math.max(long.ask, 0.1)) * 0.3;
                if (!best || score > best.score) {
                    best = {
                        score, exp, dte, long_strike: long.strike, short_strike: short.strike,
                        legs: [
                            { symbol: long.symbol, side: 'buy', ratio_qty: 1, position_intent: 'buy_to_open' },
                            { symbol: short.symbol, side: 'sell', ratio_qty: 1, position_intent: 'sell_to_open' },
                        ],
                        natural,
                        spot,
                    };
                }
            }
        }
    }
    if (!best) return null;
    const limitPrice = +(best.natural + FILL_BUFFER).toFixed(2);
    if (limitPrice * 100 > MAX_LOSS_PER_TRADE) return null; // double-check after buffer
    const width = Math.abs(best.long_strike - best.short_strike);
    return {
        ...best,
        limit_price: limitPrice,
        max_loss_usd: +(limitPrice * 100).toFixed(2),
        max_gain_usd: +(width * 100 - limitPrice * 100).toFixed(2),
        breakeven: side === 'put'
            ? +(best.long_strike - limitPrice).toFixed(2)
            : +(best.long_strike + limitPrice).toFixed(2),
        side,
        symbol,
    };
}

async function sbInsert(table, row, prefer = 'return=representation') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', headers: { ...sbHeaders(), Prefer: prefer }, body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`sb ${table}: ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return prefer.includes('representation') ? r.json() : null;
}

async function sbUpdate(table, id, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`sb update ${table}: ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function fireOrder(design, ideaContext) {
    const idea = await sbInsert('trade_ideas', {
        status: 'approved',
        symbol: design.symbol,
        strategy: design.side === 'put' ? 'put_debit_spread' : 'call_debit_spread',
        structure: { legs: design.legs, qty: 1, limit_price: design.limit_price, time_in_force: 'day' },
        thesis: ideaContext.thesis,
        invalidation: ideaContext.invalidation,
        target_dte: design.dte,
        planned_entry_price: design.limit_price,
        planned_position_size_usd: design.max_loss_usd,
        planned_max_loss_usd: design.max_loss_usd,
        planned_max_gain_usd: design.max_gain_usd,
        tags: [...(ideaContext.tags || []), 'autonomous'],
        notes: `Auto-cycle. Natural fill $${design.natural.toFixed(2)}, limit $${design.limit_price.toFixed(2)}. Long ${design.long_strike}, short ${design.short_strike}, exp ${design.exp}. Breakeven $${design.breakeven}.`,
    });
    const ideaId = idea[0].id;

    const orderBody = {
        order_class: 'mleg', type: 'limit',
        limit_price: String(design.limit_price), time_in_force: 'day', qty: '1',
        legs: design.legs.map(l => ({ ...l, ratio_qty: String(l.ratio_qty) })),
    };
    const start = Date.now();
    const r = await fetch(`${TRADING_BASE}/v2/orders`, { method: 'POST', headers: alpacaHeaders(), body: JSON.stringify(orderBody) });
    const requestId = r.headers.get('x-request-id');
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }

    sbInsert('alpaca_api_log', {
        method: 'POST', path: '/v2/orders',
        status_code: r.status, request_id: requestId,
        duration_ms: Date.now() - start,
        error: r.ok ? null : (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)),
        related_idea_id: ideaId,
    }, 'return=minimal').catch(() => {});

    if (!r.ok) {
        await sbUpdate('trade_ideas', ideaId, {
            status: 'rejected',
            rejected_reason: `Alpaca ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 500),
            alpaca_request_id: requestId,
        });
        return { ok: false, idea_id: ideaId, error: body };
    }
    await sbUpdate('trade_ideas', ideaId, {
        status: 'paper_open',
        alpaca_order_id: body.id,
        alpaca_request_id: requestId,
        opened_at: new Date().toISOString(),
    });
    return { ok: true, idea_id: ideaId, order_id: body.id, request_id: requestId, design };
}

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    // Auth: admin pw, trigger token, or Netlify Scheduled invoke
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
    const runScreener = cfg.run_screener !== false;
    const maxBearish = cfg.max_bearish ?? 2;
    const maxBullish = cfg.max_bullish ?? 1;
    const dryRun = !!cfg.dry_run;

    const summary = { ok: true, started_at: new Date().toISOString(), dry_run: dryRun, fired: [], skipped: [] };

    try {
        // 1. Optionally trigger screener (re-uses internal logic by calling our own function)
        if (runScreener) {
            const r = await fetch(`https://${event.headers.host || 'filmtranspo.com'}/.netlify/functions/screener`, {
                method: 'POST',
                headers: { 'X-Trigger-Token': process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
            });
            const j = await r.json().catch(() => ({}));
            summary.screener = { ok: j.ok, ideas_written: j.ideas_written, request_id: j.request_id };
        }

        // 2. Pull guardrail context
        const positions = await alpacaGET(TRADING_BASE, '/v2/positions').catch(() => []);
        const openSymbolsByUnderlying = new Set();
        // Each option position symbol is like AMD260522P00270000 — first 1–5 chars before digits is underlying
        for (const p of positions) {
            const m = p.symbol.match(/^([A-Z]+)\d/);
            if (m) openSymbolsByUnderlying.add(m[1]);
        }
        if (positions.length >= MAX_OPEN_POSITIONS) {
            summary.ok = false;
            summary.error = `MAX_OPEN_POSITIONS (${MAX_OPEN_POSITIONS}) reached — ${positions.length} open. Close some to free room.`;
            return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary, null, 2) };
        }

        // 3. Count today's new trades (don't exceed daily cap)
        const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
        const todayCountResp = await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?created_at=gte.${todayStart.toISOString()}&status=in.(approved,paper_open,paper_closed)&select=id`, { headers: sbHeaders() });
        const todayCount = (await todayCountResp.json()).length;
        const remainingDaily = Math.max(0, MAX_NEW_TRADES_PER_DAY - todayCount);
        if (remainingDaily === 0) {
            summary.ok = false;
            summary.error = `MAX_NEW_TRADES_PER_DAY (${MAX_NEW_TRADES_PER_DAY}) reached. ${todayCount} fired today.`;
            return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary, null, 2) };
        }

        // 4. Pull fresh ideas (last 6h, status='idea')
        const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
        const ideasResp = await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?status=eq.idea&created_at=gte.${cutoff}&order=created_at.desc&select=*`, { headers: sbHeaders() });
        const ideas = await ideasResp.json();

        const bearishIdeas = ideas.filter(i => (i.tags || []).includes('bearish'));
        const bullishIdeas = ideas.filter(i => (i.tags || []).includes('bullish'));

        const targets = [
            ...bearishIdeas.slice(0, maxBearish).map(i => ({ ...i, side: 'put' })),
            ...bullishIdeas.slice(0, maxBullish).map(i => ({ ...i, side: 'call' })),
        ];

        // 5. Loop: design + fire
        let fired = 0;
        for (const t of targets) {
            if (fired >= remainingDaily) {
                summary.skipped.push({ symbol: t.symbol, reason: 'daily cap reached during loop' });
                continue;
            }
            if (openSymbolsByUnderlying.has(t.symbol)) {
                summary.skipped.push({ symbol: t.symbol, reason: 'already have a position on this underlying' });
                continue;
            }
            try {
                const design = await designSpread({ symbol: t.symbol, side: t.side });
                if (!design) {
                    summary.skipped.push({ symbol: t.symbol, side: t.side, reason: 'no fillable structure within cap' });
                    continue;
                }
                if (dryRun) {
                    summary.fired.push({ symbol: t.symbol, side: t.side, dry_run: true, design });
                    fired++;
                    continue;
                }
                const result = await fireOrder(design, {
                    thesis: t.thesis,
                    invalidation: t.invalidation,
                    tags: t.tags,
                });
                if (result.ok) {
                    summary.fired.push({
                        symbol: t.symbol, side: t.side, order_id: result.order_id,
                        idea_id: result.idea_id, request_id: result.request_id,
                        long_strike: design.long_strike, short_strike: design.short_strike,
                        expiry: design.exp, limit: design.limit_price,
                        max_loss: design.max_loss_usd, max_gain: design.max_gain_usd, breakeven: design.breakeven,
                    });
                    fired++;
                    openSymbolsByUnderlying.add(t.symbol); // prevent dupes inside this loop
                } else {
                    summary.skipped.push({ symbol: t.symbol, reason: 'fire failed', detail: result.error });
                }
            } catch (e) {
                summary.skipped.push({ symbol: t.symbol, reason: 'design/fire error', error: e.message });
            }
        }

        summary.fired_count = summary.fired.length;
        summary.skipped_count = summary.skipped.length;
        summary.guardrails = {
            max_open_positions: MAX_OPEN_POSITIONS,
            max_new_trades_per_day: MAX_NEW_TRADES_PER_DAY,
            max_loss_per_trade: MAX_LOSS_PER_TRADE,
            today_count_after: todayCount + summary.fired.length,
            open_positions_after: positions.length + summary.fired.length,
        };

        return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(summary, null, 2) };
    } catch (err) {
        console.error('trade-cycle error', err);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message, stack: err.stack?.slice(0, 500) }) };
    }
};

// Netlify Scheduled Function: runs every weekday at 13:35 UTC (9:35 AM ET, 5 min after market open).
// At market open quotes are noisy; we wait 5 min for the dust to settle.
exports.config = {
    schedule: '35 13 * * 1-5',
};
