/**
 * GET /.netlify/functions/options-chain?symbol=AMD&side=put&dte_min=21&dte_max=45
 *
 * Returns a clean options chain for the given underlying:
 * - Underlying current price (from /v2/stocks/{sym}/snapshot)
 * - Contracts in the requested DTE range and side (put/call)
 * - Limited to ±15% of spot by default (override with strike_pct)
 * - Each contract carries strike, expiry, dte, bid, ask, mid, oi
 *
 * Auth: X-Admin-Password or X-Trigger-Token (same pattern as other admin fns).
 */

const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';

const headers = () => ({
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Accept': 'application/json',
});

async function getUnderlyingPrice(symbol) {
    const r = await fetch(`${DATA_BASE}/v2/stocks/${symbol}/snapshot?feed=iex`, { headers: headers() });
    if (!r.ok) throw new Error(`underlying snapshot ${symbol} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    // Prefer latest trade, fall back to latest quote mid, then daily close
    if (j.latestTrade?.p) return { price: j.latestTrade.p, source: 'latestTrade', as_of: j.latestTrade.t };
    if (j.latestQuote?.bp && j.latestQuote?.ap) return { price: (j.latestQuote.bp + j.latestQuote.ap) / 2, source: 'quote_mid', as_of: j.latestQuote.t };
    if (j.dailyBar?.c) return { price: j.dailyBar.c, source: 'dailyBar', as_of: j.dailyBar.t };
    if (j.prevDailyBar?.c) return { price: j.prevDailyBar.c, source: 'prevDailyBar', as_of: j.prevDailyBar.t };
    throw new Error(`No price found for ${symbol}`);
}

async function listContracts({ symbol, side, expirationGte, expirationLte, strikeMin, strikeMax }) {
    const params = new URLSearchParams({
        underlying_symbols: symbol,
        type: side,
        status: 'active',
        expiration_date_gte: expirationGte,
        expiration_date_lte: expirationLte,
        strike_price_gte: String(strikeMin),
        strike_price_lte: String(strikeMax),
        limit: '200',
    });
    const all = [];
    let pageToken = null;
    for (let i = 0; i < 5; i++) { // safety cap on pagination
        if (pageToken) params.set('page_token', pageToken);
        const r = await fetch(`${TRADING_BASE}/v2/options/contracts?${params.toString()}`, { headers: headers() });
        if (!r.ok) throw new Error(`contracts ${symbol} ${r.status}: ${await r.text()}`);
        const j = await r.json();
        if (j.option_contracts) all.push(...j.option_contracts);
        pageToken = j.next_page_token;
        if (!pageToken) break;
    }
    return all;
}

async function fetchSnapshots(contractSymbols) {
    if (!contractSymbols.length) return {};
    // /v1beta1/options/snapshots accepts a comma-separated symbols list
    const out = {};
    // Chunk to avoid URL length issues — 50 per call is comfortable
    for (let i = 0; i < contractSymbols.length; i += 50) {
        const chunk = contractSymbols.slice(i, i + 50);
        const params = new URLSearchParams({ symbols: chunk.join(','), feed: 'indicative' });
        const r = await fetch(`${DATA_BASE}/v1beta1/options/snapshots?${params.toString()}`, { headers: headers() });
        if (!r.ok) {
            console.warn(`snapshot chunk ${r.status}: ${await r.text()}`);
            continue;
        }
        const j = await r.json();
        if (j.snapshots) Object.assign(out, j.snapshots);
    }
    return out;
}

function daysBetween(a, b) {
    const ms = b.getTime() - a.getTime();
    return Math.round(ms / 86400000);
}

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const expectedAdminPw = process.env.ADMIN_PASSWORD;
    const ok = (expectedTrigger && trigger === expectedTrigger) || (expectedAdminPw && adminPw === expectedAdminPw);
    if (!ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

    try {
        const params = event.queryStringParameters || {};
        const symbol = (params.symbol || '').toUpperCase();
        const side = (params.side || 'put').toLowerCase();
        const dteMin = parseInt(params.dte_min || '21', 10);
        const dteMax = parseInt(params.dte_max || '45', 10);
        const strikePct = parseFloat(params.strike_pct || '15') / 100; // ±15% of spot by default

        if (!symbol) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'symbol required' }) };
        if (!['put', 'call'].includes(side)) return { statusCode: 400, headers: cors, body: JSON.stringify({ ok: false, error: 'side must be put or call' }) };

        const { price, source: priceSource, as_of: priceAsOf } = await getUnderlyingPrice(symbol);
        const strikeMin = Math.floor(price * (1 - strikePct));
        const strikeMax = Math.ceil(price * (1 + strikePct));

        const today = new Date();
        const min = new Date(today.getTime() + dteMin * 86400000);
        const max = new Date(today.getTime() + dteMax * 86400000);
        const fmt = (d) => d.toISOString().split('T')[0];

        const contracts = await listContracts({
            symbol, side,
            expirationGte: fmt(min),
            expirationLte: fmt(max),
            strikeMin, strikeMax,
        });

        const symbols = contracts.map(c => c.symbol);
        const snapshots = await fetchSnapshots(symbols);

        const merged = contracts.map(c => {
            const snap = snapshots[c.symbol];
            const q = snap?.latestQuote;
            const bid = q?.bp ?? null;
            const ask = q?.ap ?? null;
            const mid = (bid != null && ask != null) ? +((bid + ask) / 2).toFixed(2) : null;
            const expiry = c.expiration_date;
            const dte = daysBetween(today, new Date(expiry + 'T16:00:00Z'));
            return {
                symbol: c.symbol,
                strike: parseFloat(c.strike_price),
                expiry,
                dte,
                bid, ask, mid,
                spread_pct: (mid && mid > 0) ? +(((ask - bid) / mid) * 100).toFixed(1) : null,
                open_interest: c.open_interest ? parseInt(c.open_interest, 10) : null,
                tradable: c.tradable,
            };
        }).filter(c => c.bid != null && c.ask != null) // drop contracts without quotes
          .sort((a, b) => a.strike - b.strike);

        return {
            statusCode: 200,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                underlying: symbol,
                underlying_price: +price.toFixed(2),
                price_source: priceSource,
                price_as_of: priceAsOf,
                side,
                dte_window: [dteMin, dteMax],
                strike_window: [strikeMin, strikeMax],
                contracts: merged,
                count: merged.length,
            }, null, 2),
        };
    } catch (err) {
        console.error('options-chain error', err);
        return { statusCode: 500, headers: cors, body: JSON.stringify({ ok: false, error: err.message }) };
    }
};
