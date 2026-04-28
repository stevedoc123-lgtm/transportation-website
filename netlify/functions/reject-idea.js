/**
 * POST /.netlify/functions/reject-idea  body: { id, reason? }
 *
 * Marks a pending_approval trade idea as rejected so it disappears
 * from the pending list.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';

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

    const r = await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas?id=eq.${req.id}`, {
        method: 'PATCH',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'rejected', rejected_reason: req.reason || 'manually rejected from /trading/' }),
    });
    if (!r.ok) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: `update ${r.status}: ${await r.text()}` }) };

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
};
