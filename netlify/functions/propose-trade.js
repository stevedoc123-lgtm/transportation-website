/**
 * POST /.netlify/functions/propose-trade
 *
 * Inserts a designed trade into trade_ideas with status='pending_approval'.
 * Used by Claude (or any authenticated client) to drop a structure into
 * the queue. Steve then sees it on /trading/ and clicks Approve to fire,
 * or Reject to discard.
 *
 * Body shape matches submit-order's body exactly — same fields — except
 * no order is placed; just the proposal row is created.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';
const MAX_LOSS_PER_TRADE = parseFloat(process.env.MAX_LOSS_PER_TRADE || '125');

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

    const required = ['underlying', 'strategy', 'legs', 'limit_price', 'planned_max_loss_usd'];
    for (const f of required) {
        if (req[f] == null) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: `missing field: ${f}` }) };
    }

    if (parseFloat(req.planned_max_loss_usd) > MAX_LOSS_PER_TRADE) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: `planned_max_loss_usd $${req.planned_max_loss_usd} exceeds cap $${MAX_LOSS_PER_TRADE}` }) };
    }

    const row = {
        status: 'pending_approval',
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

    const r = await fetch(`${SUPABASE_URL}/rest/v1/trade_ideas`, {
        method: 'POST',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
        },
        body: JSON.stringify(row),
    });
    if (!r.ok) return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: `insert ${r.status}: ${await r.text()}` }) };
    const inserted = await r.json();
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, idea: inserted[0] }, null, 2) };
};
