/**
 * POST /.netlify/functions/submit-order
 *
 * Submits a multi-leg options order to Alpaca paper, then logs it
 * to the trade_ideas table with status='paper_open'.
 *
 * Body:
 * {
 *   "underlying": "AMD",
 *   "strategy": "put_debit_spread",
 *   "thesis": "...",
 *   "invalidation": "...",
 *   "legs": [
 *     { "symbol": "AMD260522P00285000", "side": "buy",  "ratio_qty": 1, "position_intent": "buy_to_open" },
 *     { "symbol": "AMD260522P00280000", "side": "sell", "ratio_qty": 1, "position_intent": "sell_to_open" }
 *   ],
 *   "limit_price": 1.12,
 *   "qty": 1,
 *   "time_in_force": "day",
 *   "planned_max_loss_usd": 112,
 *   "planned_max_gain_usd": 388,
 *   "breakeven": 283.88,
 *   "tags": ["screener_v1", "bearish"]
 * }
 *
 * Auth: X-Admin-Password or X-Trigger-Token.
 *
 * Hard rules enforced server-side:
 * - planned_max_loss_usd must be <= MAX_LOSS_PER_TRADE (default $125)
 * - Underlying must be on the production env's ALPACA_BASE_URL (paper)
 *   when running in paper mode
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const MAX_LOSS_PER_TRADE = parseFloat(process.env.MAX_LOSS_PER_TRADE || '125');

const alpacaHeaders = () => ({
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
});

async function sbInsert(table, row, prefer = 'return=representation') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: prefer,
        },
        body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`Supabase ${table} insert ${r.status}: ${await r.text()}`);
    return prefer.includes('representation') ? r.json() : null;
}

async function sbUpdate(table, id, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`Supabase ${table} update ${r.status}: ${await r.text()}`);
}

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'POST required' };

    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const expectedAdminPw = process.env.ADMIN_PASSWORD;
    const ok = (expectedTrigger && trigger === expectedTrigger) || (expectedAdminPw && adminPw === expectedAdminPw);
    if (!ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

    let req;
    try { req = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'invalid JSON body' }) }; }

    const required = ['underlying', 'strategy', 'legs', 'limit_price', 'planned_max_loss_usd'];
    for (const f of required) {
        if (req[f] == null) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: `missing field: ${f}` }) };
    }

    if (parseFloat(req.planned_max_loss_usd) > MAX_LOSS_PER_TRADE) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: `planned_max_loss_usd $${req.planned_max_loss_usd} exceeds cap $${MAX_LOSS_PER_TRADE}` }) };
    }

    const isPaper = TRADING_BASE.includes('paper-api');

    // 1. Insert idea row first as 'approved' so we have an audit trail even
    //    if the Alpaca submission fails.
    const ideaRow = {
        status: 'approved',
        symbol: req.underlying,
        strategy: req.strategy,
        structure: { legs: req.legs, qty: req.qty || 1, limit_price: req.limit_price, time_in_force: req.time_in_force || 'day' },
        thesis: req.thesis || null,
        invalidation: req.invalidation || null,
        target_dte: req.target_dte ?? null,
        planned_entry_price: req.limit_price,
        planned_position_size_usd: parseFloat(req.planned_max_loss_usd),
        planned_max_loss_usd: parseFloat(req.planned_max_loss_usd),
        planned_max_gain_usd: req.planned_max_gain_usd ?? null,
        tags: req.tags || [],
        notes: req.breakeven != null ? `Breakeven: $${req.breakeven}` : null,
    };

    const inserted = await sbInsert('trade_ideas', ideaRow);
    const ideaId = inserted[0]?.id;

    // 2. Submit the multi-leg order to Alpaca
    const orderBody = {
        order_class: 'mleg',
        type: 'limit',
        limit_price: String(req.limit_price),
        time_in_force: req.time_in_force || 'day',
        qty: String(req.qty || 1),
        legs: req.legs.map(l => ({
            symbol: l.symbol,
            side: l.side,
            ratio_qty: String(l.ratio_qty || 1),
            position_intent: l.position_intent || (l.side === 'buy' ? 'buy_to_open' : 'sell_to_open'),
        })),
    };

    const start = Date.now();
    let resp, requestId, bodyText, body, durationMs;
    try {
        resp = await fetch(`${TRADING_BASE}/v2/orders`, {
            method: 'POST',
            headers: alpacaHeaders(),
            body: JSON.stringify(orderBody),
        });
        requestId = resp.headers.get('x-request-id');
        durationMs = Date.now() - start;
        bodyText = await resp.text();
        try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
    } catch (err) {
        await sbUpdate('trade_ideas', ideaId, { status: 'rejected', rejected_reason: `Network error: ${err.message}` });
        return { statusCode: 502, headers: cors, body: JSON.stringify({ ok: false, error: err.message, idea_id: ideaId }) };
    }

    // Log every Alpaca call for auditability (Alpaca's recommendation)
    await sbInsert('alpaca_api_log', {
        method: 'POST',
        path: '/v2/orders',
        status_code: resp.status,
        request_id: requestId,
        duration_ms: durationMs,
        error: resp.ok ? null : (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)),
        related_idea_id: ideaId,
    }, 'return=minimal').catch(() => {});

    if (!resp.ok) {
        await sbUpdate('trade_ideas', ideaId, {
            status: 'rejected',
            rejected_reason: `Alpaca ${resp.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 500),
            alpaca_request_id: requestId,
        });
        return {
            statusCode: 502,
            headers: cors,
            body: JSON.stringify({ ok: false, error: 'Alpaca rejected order', alpaca_status: resp.status, alpaca_body: body, request_id: requestId, idea_id: ideaId }),
        };
    }

    // 3. Update idea with the live order id + paper_open status
    await sbUpdate('trade_ideas', ideaId, {
        status: 'paper_open',
        alpaca_order_id: body.id,
        alpaca_request_id: requestId,
        opened_at: new Date().toISOString(),
    });

    return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ok: true,
            paper: isPaper,
            idea_id: ideaId,
            order_id: body.id,
            request_id: requestId,
            order_status: body.status,
            order_class: body.order_class,
            limit_price: body.limit_price,
            legs: body.legs?.map(l => ({ symbol: l.symbol, side: l.side, ratio_qty: l.ratio_qty })) || [],
            submitted_at: body.submitted_at,
        }, null, 2),
    };
};
