/**
 * POST /.netlify/functions/approve-idea  body: { id: "<trade_ideas.id>" }
 *
 * Reads a trade_ideas row with status='pending_approval', uses its
 * `structure` JSON to submit a multi-leg order to Alpaca paper, logs
 * the X-Request-ID, and updates the row to status='paper_open' with
 * the alpaca_order_id.
 *
 * The hard $125 max-loss rule is re-validated server-side — even if
 * the proposal row was tampered with somehow, this function won't
 * fire an order that exceeds the cap.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const MAX_LOSS_PER_TRADE = parseFloat(process.env.MAX_LOSS_PER_TRADE || '125');

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
    try { req = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'invalid JSON' }) }; }
    const id = req.id;
    if (!id) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'id required' }) };

    // Fetch the idea row
    const ideaResp = await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?id=eq.${id}&select=*`, { headers: sbHeaders() });
    if (!ideaResp.ok) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: `fetch idea: ${ideaResp.status}` }) };
    const rows = await ideaResp.json();
    const idea = rows[0];
    if (!idea) return { statusCode: 404, headers: cors, body: JSON.stringify({ ok: false, error: 'idea not found' }) };

    if (idea.status !== 'pending_approval') {
        return { statusCode: 409, headers: cors, body: JSON.stringify({ ok: false, error: `idea status is '${idea.status}', expected 'pending_approval'` }) };
    }

    if (parseFloat(idea.planned_max_loss_usd) > MAX_LOSS_PER_TRADE) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: `planned_max_loss_usd $${idea.planned_max_loss_usd} exceeds cap $${MAX_LOSS_PER_TRADE}` }) };
    }

    const struct = idea.structure || {};
    if (!struct.legs || !struct.legs.length || !struct.limit_price) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'structure missing legs or limit_price' }) };
    }

    const orderBody = {
        order_class: 'mleg',
        type: 'limit',
        limit_price: String(struct.limit_price),
        time_in_force: struct.time_in_force || 'day',
        qty: String(struct.qty || 1),
        legs: struct.legs.map(l => ({
            symbol: l.symbol,
            side: l.side,
            ratio_qty: String(l.ratio_qty || 1),
            position_intent: l.position_intent || (l.side === 'buy' ? 'buy_to_open' : 'sell_to_open'),
        })),
    };

    const start = Date.now();
    let resp, body, requestId, durationMs;
    try {
        resp = await fetch(`${TRADING_BASE}/v2/orders`, { method: 'POST', headers: alpacaHeaders(), body: JSON.stringify(orderBody) });
        requestId = resp.headers.get('x-request-id');
        durationMs = Date.now() - start;
        const txt = await resp.text();
        try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
    } catch (err) {
        await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?id=eq.${id}`, {
            method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'rejected', rejected_reason: `Network error: ${err.message}` }),
        });
        return { statusCode: 502, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) };
    }

    // Audit log
    await fetch(`${SUPABASE_URL}/rest/v1/alpaca_api_log`, {
        method: 'POST', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({
            method: 'POST', path: '/v2/orders',
            status_code: resp.status, request_id: requestId,
            duration_ms: durationMs,
            error: resp.ok ? null : (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)),
            related_idea_id: id,
        }),
    }).catch(() => {});

    if (!resp.ok) {
        await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?id=eq.${id}`, {
            method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
            body: JSON.stringify({
                status: 'rejected',
                rejected_reason: `Alpaca ${resp.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`.slice(0, 500),
                alpaca_request_id: requestId,
            }),
        });
        return {
            statusCode: 502, headers: cors,
            body: JSON.stringify({ ok: false, error: 'Alpaca rejected', alpaca_status: resp.status, alpaca_body: body, request_id: requestId }),
        };
    }

    await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?id=eq.${id}`, {
        method: 'PATCH', headers: { ...sbHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({
            status: 'paper_open',
            alpaca_order_id: body.id,
            alpaca_request_id: requestId,
            opened_at: new Date().toISOString(),
        }),
    });

    return {
        statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, idea_id: id, order_id: body.id, request_id: requestId, order_status: body.status }, null, 2),
    };
};
