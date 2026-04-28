/**
 * GET /.netlify/functions/admin-data
 *
 * Returns recent trade_ideas, recent briefs, and Alpaca account snapshot
 * for the /trading/ admin page. Reads via SUPABASE_SERVICE_ROLE_KEY
 * server-side, so the browser never sees the key.
 *
 * Auth: X-Admin-Password matching ADMIN_PASSWORD env var, OR
 *       X-Trigger-Token matching SUPABASE_SERVICE_ROLE_KEY.
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';

async function sb(path) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Supabase ${path} ${resp.status}: ${txt.slice(0, 200)}`);
    }
    return resp.json();
}

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const expectedAdminPw = process.env.ADMIN_PASSWORD;
    const ok = (expectedTrigger && trigger === expectedTrigger) || (expectedAdminPw && adminPw === expectedAdminPw);
    if (!ok) {
        return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }

    try {
        const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
        const alpacaHeaders = {
            'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
            'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        };

        const [ideas, briefs, account, positions, openOrders] = await Promise.all([
            sb(`trade_ideas?created_at=gte.${cutoff}&order=created_at.desc&select=*&limit=50`),
            sb(`research_briefs?order=created_at.desc&select=*&limit=10`),
            (async () => {
                const r = await fetch(`${process.env.ALPACA_BASE_URL}/v2/account`, { headers: alpacaHeaders });
                if (!r.ok) return null;
                const a = await r.json();
                return {
                    cash: a.cash, buying_power: a.buying_power, portfolio_value: a.portfolio_value,
                    equity: a.equity, options_trading_level: a.options_trading_level,
                    paper: process.env.ALPACA_BASE_URL?.includes('paper'),
                };
            })(),
            (async () => {
                const r = await fetch(`${process.env.ALPACA_BASE_URL}/v2/positions`, { headers: alpacaHeaders });
                if (!r.ok) return [];
                return r.json();
            })(),
            (async () => {
                const r = await fetch(`${process.env.ALPACA_BASE_URL}/v2/orders?status=open&limit=50&nested=true`, { headers: alpacaHeaders });
                if (!r.ok) return [];
                return r.json();
            })(),
        ]);

        return {
            statusCode: 200,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ideas, briefs, account, positions, open_orders: openOrders }, null, 2),
        };
    } catch (err) {
        return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};
