/**
 * POST /.netlify/functions/cancel-order  body: { id: "<alpaca order id>" }
 *
 * Cancels an open Alpaca order. Used by the "Cancel" button next to
 * each open order on /trading/.
 */

const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'POST required' };

    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const expectedAdmin = process.env.ADMIN_PASSWORD;
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ok = (expectedAdmin && adminPw === expectedAdmin) || (expectedTrigger && trigger === expectedTrigger);
    if (!ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

    let req;
    try { req = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: 'invalid JSON' }; }
    if (!req.id) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'id required' }) };

    const r = await fetch(`${TRADING_BASE}/v2/orders/${req.id}`, {
        method: 'DELETE',
        headers: {
            'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
            'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        },
    });
    if (!r.ok && r.status !== 204) {
        const txt = await r.text();
        return { statusCode: 502, headers: cors, body: JSON.stringify({ ok: false, error: `Alpaca ${r.status}: ${txt}` }) };
    }

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, request_id: r.headers.get('x-request-id') }) };
};
