/**
 * POST /.netlify/functions/screener
 *
 * Fetches daily bars from Alpaca for a curated universe, computes
 * technicals (RSI14, 20d momentum, distance from 60d high, distance from
 * 50d MA), scores bearish and bullish setups, and writes the top
 * candidates to the Supabase `trade_ideas` table.
 *
 * Auth: requires X-Trigger-Token matching SCREENER_TOKEN env var (or
 * SUPABASE_SERVICE_ROLE_KEY as fallback so we don't add another secret).
 *
 * Required env: ALPACA_KEY_ID, ALPACA_SECRET_KEY, ALPACA_BASE_URL,
 *               SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';

// 30 high-liquidity names with active options chains. Mix of mega-cap tech,
// consumer staples, financials, industrials, energy, healthcare, plus the
// big index ETFs for hedges.
const UNIVERSE = [
    'SPY', 'QQQ', 'IWM',
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
    'AMD', 'AVGO', 'NFLX', 'ADBE',
    'COST', 'WMT', 'HD', 'NKE', 'MCD',
    'V', 'MA', 'JPM', 'BAC', 'GS',
    'BA', 'CAT',
    'XOM', 'CVX',
    'UNH', 'LLY',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function alpacaFetch(path, init = {}) {
    const url = `${process.env.ALPACA_BASE_URL}${path}`;
    const start = Date.now();
    const resp = await fetch(url, {
        ...init,
        headers: {
            'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
            'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
            'Accept': 'application/json',
            ...(init.headers || {}),
        },
    });
    const requestId = resp.headers.get('x-request-id');
    const durationMs = Date.now() - start;
    const text = await resp.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }

    // Fire-and-forget log to Supabase. Don't block on this.
    logAlpacaCall({
        method: init.method || 'GET',
        path,
        status_code: resp.status,
        request_id: requestId,
        duration_ms: durationMs,
        error: resp.ok ? null : (typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)),
    }).catch(err => console.warn('alpaca log failed:', err.message));

    if (!resp.ok) {
        const e = new Error(`Alpaca ${resp.status} on ${path}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
        e.requestId = requestId;
        e.status = resp.status;
        throw e;
    }
    return { body, requestId, durationMs };
}

async function logAlpacaCall(row) {
    return supabaseInsert('alpaca_api_log', row);
}

async function supabaseInsert(table, row, prefer = 'return=minimal') {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: prefer,
        },
        body: JSON.stringify(row),
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Supabase insert ${table} ${resp.status}: ${txt.slice(0, 200)}`);
    }
    if (prefer.includes('representation')) return await resp.json();
    return null;
}

async function supabaseUpsert(table, rows, onConflict, prefer = 'return=minimal,resolution=merge-duplicates') {
    const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: prefer,
        },
        body: JSON.stringify(rows),
    });
    if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Supabase upsert ${table} ${resp.status}: ${txt.slice(0, 200)}`);
    }
    return null;
}

async function supabaseSelect(table, query) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
        headers: {
            apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Accept': 'application/json',
        },
    });
    if (!resp.ok) throw new Error(`Supabase select ${table} ${resp.status}`);
    return await resp.json();
}

// ── Options / IV helpers ───────────────────────────────────────────────────

const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE_OPTS = 'https://data.alpaca.markets';

function alpacaHeaders() {
    return {
        'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        'Accept': 'application/json',
    };
}

async function listAtmContracts(symbol, spot, side, dteMin = 21, dteMax = 45, strikeBandPct = 8) {
    const today = new Date();
    const min = new Date(today.getTime() + dteMin * 86400000);
    const max = new Date(today.getTime() + dteMax * 86400000);
    const fmt = (d) => d.toISOString().split('T')[0];
    const strikeMin = spot * (1 - strikeBandPct / 100);
    const strikeMax = spot * (1 + strikeBandPct / 100);
    const params = new URLSearchParams({
        underlying_symbols: symbol,
        type: side,
        status: 'active',
        expiration_date_gte: fmt(min),
        expiration_date_lte: fmt(max),
        strike_price_gte: strikeMin.toFixed(2),
        strike_price_lte: strikeMax.toFixed(2),
        limit: '100',
    });
    const r = await fetch(`${TRADING_BASE}/v2/options/contracts?${params}`, { headers: alpacaHeaders() });
    if (!r.ok) return [];
    const j = await r.json();
    return j.option_contracts || [];
}

function pickAtmFromContracts(contracts, spot, targetDte = 30) {
    if (!contracts.length) return null;
    const byExpiry = {};
    for (const c of contracts) {
        (byExpiry[c.expiration_date] = byExpiry[c.expiration_date] || []).push(c);
    }
    let best = null;
    for (const [expiry, list] of Object.entries(byExpiry)) {
        const closest = list.reduce((a, b) =>
            Math.abs(parseFloat(a.strike_price) - spot) < Math.abs(parseFloat(b.strike_price) - spot) ? a : b
        );
        const dte = Math.round((new Date(expiry + 'T16:00:00Z').getTime() - Date.now()) / 86400000);
        const atmDistPct = Math.abs(parseFloat(closest.strike_price) - spot) / spot * 100;
        // Score: closer to target DTE and closer to ATM both win
        const score = -Math.abs(dte - targetDte) - atmDistPct * 2;
        if (!best || score > best.score) best = { contract: closest, dte, atmDistPct, expiry, score };
    }
    return best;
}

async function fetchOptionSnapshots(contractSymbols) {
    if (!contractSymbols.length) return {};
    const out = {};
    for (let i = 0; i < contractSymbols.length; i += 50) {
        const chunk = contractSymbols.slice(i, i + 50);
        const params = new URLSearchParams({ symbols: chunk.join(','), feed: 'indicative' });
        const r = await fetch(`${DATA_BASE_OPTS}/v1beta1/options/snapshots?${params}`, { headers: alpacaHeaders() });
        if (!r.ok) continue;
        const j = await r.json();
        if (j.snapshots) Object.assign(out, j.snapshots);
    }
    return out;
}

async function findAtmStraddle(symbol, spot) {
    const [calls, puts] = await Promise.all([
        listAtmContracts(symbol, spot, 'call').catch(() => []),
        listAtmContracts(symbol, spot, 'put').catch(() => []),
    ]);
    const callPick = pickAtmFromContracts(calls, spot);
    const putPick = pickAtmFromContracts(puts, spot);
    return { callPick, putPick };
}

// ── VIX market-wide regime overlay ─────────────────────────────────────────
// Free source: CBOE's official VIX_History.csv (no auth, no rate limit).

async function fetchVixHistory() {
    const url = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';
    const r = await fetch(url, { headers: { 'Accept': 'text/csv' } });
    if (!r.ok) throw new Error(`VIX fetch ${r.status}`);
    const text = await r.text();
    const lines = text.split('\n').slice(1).filter(l => l.trim());
    const rows = [];
    for (const l of lines) {
        const cols = l.split(',');
        if (cols.length < 5) continue;
        const close = parseFloat(cols[4]);
        if (!Number.isFinite(close)) continue;
        // CBOE date format is M/D/YYYY — normalize to YYYY-MM-DD
        const [m, d, y] = cols[0].split('/');
        if (!y) continue;
        const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        rows.push({ date, close });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
}

function computeVixRegime(history, lookback = 252) {
    if (!history || history.length < 30) return null;
    const slice = history.slice(-lookback);
    const closes = slice.map(r => r.close);
    const current = closes[closes.length - 1];
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const rank = max === min ? 50 : ((current - min) / (max - min)) * 100;
    const below = closes.filter(c => c < current).length;
    const percentile = (below / closes.length) * 100;
    let regime;
    if (rank >= 80) regime = 'rich';
    else if (rank >= 60) regime = 'elevated';
    else if (rank >= 40) regime = 'fair';
    else if (rank >= 20) regime = 'cheap';
    else regime = 'very cheap';
    return {
        current: +current.toFixed(2),
        rank: +rank.toFixed(1),
        percentile: +percentile.toFixed(1),
        regime,
        as_of: slice[slice.length - 1].date,
        sample_count: closes.length,
    };
}

function computePercentile(history, currentIv) {
    if (!history || history.length === 0) return { rank: null, percentile: null };
    const ivs = history.map(h => h.atm_iv).filter(v => v != null);
    if (ivs.length === 0) return { rank: null, percentile: null };
    const min = Math.min(...ivs);
    const max = Math.max(...ivs);
    const rank = max === min ? 50 : ((currentIv - min) / (max - min)) * 100;
    const below = ivs.filter(v => v < currentIv).length;
    const percentile = (below / ivs.length) * 100;
    return {
        rank: Math.max(0, Math.min(100, +rank.toFixed(2))),
        percentile: +percentile.toFixed(2),
        sampleCount: ivs.length,
    };
}

// ── Technicals ──────────────────────────────────────────────────────────────

function rsi14(closes) {
    if (closes.length < 15) return null;
    let gains = 0, losses = 0;
    // Initial average over first 14 changes
    for (let i = 1; i <= 14; i++) {
        const ch = closes[i] - closes[i - 1];
        if (ch >= 0) gains += ch; else losses -= ch;
    }
    let avgGain = gains / 14;
    let avgLoss = losses / 14;
    // Wilder smoothing for the rest
    for (let i = 15; i < closes.length; i++) {
        const ch = closes[i] - closes[i - 1];
        const g = ch > 0 ? ch : 0;
        const l = ch < 0 ? -ch : 0;
        avgGain = (avgGain * 13 + g) / 14;
        avgLoss = (avgLoss * 13 + l) / 14;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function sma(values, n) {
    if (values.length < n) return null;
    const slice = values.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / n;
}

function pctReturn(closes, n) {
    if (closes.length < n + 1) return null;
    const start = closes[closes.length - 1 - n];
    const end = closes[closes.length - 1];
    return (end / start - 1) * 100;
}

function realizedVolPct(closes, n) {
    if (closes.length < n + 1) return null;
    const rets = [];
    for (let i = closes.length - n; i < closes.length; i++) {
        rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized %
}

function analyze(symbol, bars) {
    if (!bars || bars.length < 21) return null;
    const closes = bars.map(b => b.c);
    const last = closes[closes.length - 1];
    const high60 = Math.max(...closes);
    const ma50 = sma(closes, Math.min(50, closes.length));
    const distFromHighPct = (last / high60 - 1) * 100;          // negative = below high
    const distFromMaPct = ma50 ? (last / ma50 - 1) * 100 : null; // positive = above MA
    const rsi = rsi14(closes);
    const mom20 = pctReturn(closes, 20);
    const vol20 = realizedVolPct(closes, 20);

    return {
        symbol,
        last,
        high60,
        ma50,
        distFromHighPct,
        distFromMaPct,
        rsi,
        mom20,
        vol20,
        bars: closes.length,
    };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

// IV-regime adjustment: debit spreads dominate at $125 cap, so chasing rich
// premium hurts expectancy. Reward cheap premium, penalize rich.
// Prefers ivRank when meaningful (history >= 30 days), falls back to IV/HV ratio.
function ivRegimeAdjust(a) {
    if (a.ivRank != null && a.ivSampleCount >= 30) {
        if (a.ivRank <= 25) return +4;       // very cheap
        if (a.ivRank <= 50) return +1;
        if (a.ivRank >= 80) return -5;       // very rich
        if (a.ivRank >= 65) return -2;
        return 0;
    }
    if (a.ivHvRatio != null) {
        if (a.ivHvRatio < 1.0) return +3;    // IV below realized = cheap
        if (a.ivHvRatio < 1.2) return +1;
        if (a.ivHvRatio > 1.6) return -4;    // IV well above realized = rich
        if (a.ivHvRatio > 1.4) return -2;
    }
    return 0;
}

function scoreBearish(a) {
    // Reward overbought + extended above MA + steep recent momentum.
    let s = 0;
    if (a.rsi != null && a.rsi >= 70) s += (a.rsi - 70) * 2;
    if (a.distFromMaPct != null && a.distFromMaPct >= 8) s += (a.distFromMaPct - 8) * 1.5;
    if (a.mom20 != null && a.mom20 >= 10) s += (a.mom20 - 10);
    // Penalize names already pulling back hard from highs (the move may be done)
    if (a.distFromHighPct != null && a.distFromHighPct < -10) s -= 10;
    s += ivRegimeAdjust(a);
    return s;
}

function scoreBullish(a) {
    // Reward uptrend (price > MA) but pulled back to a reasonable entry,
    // plus neutral-to-slightly-bouncing RSI. Hard requirement: positive
    // 20d momentum so we don't mistake a downtrend for a pullback.
    if (a.mom20 == null || a.mom20 < 0) return 0;          // hard gate: no falling knives
    if (a.distFromMaPct != null && a.distFromMaPct < -3) return 0; // and not below MA

    let s = 0;
    if (a.distFromMaPct != null && a.distFromMaPct >= -2 && a.distFromMaPct <= 8) {
        s += 12 - Math.abs(a.distFromMaPct - 3);          // peak around price ~3% above MA
    }
    // RSI: prefer the bounce-friendly range. Reduced weight vs prior.
    if (a.rsi != null && a.rsi >= 40 && a.rsi <= 58) s += (15 - Math.abs(a.rsi - 49));
    // Pullbacks within an uptrend: 4-14% off the 60d high is the sweet spot
    if (a.distFromHighPct != null && a.distFromHighPct <= -4 && a.distFromHighPct >= -14) {
        s += 10;
    }
    // Bonus for actually trending up over 20d
    if (a.mom20 >= 2 && a.mom20 <= 12) s += 5;
    s += ivRegimeAdjust(a);
    return s;
}

function ivLabel(a) {
    if (a.atmIv == null) return null;
    const ivPct = (a.atmIv * 100).toFixed(1);
    if (a.ivRank != null && a.ivSampleCount >= 30) {
        let regime;
        if (a.ivRank <= 25) regime = 'cheap';
        else if (a.ivRank <= 50) regime = 'fair';
        else if (a.ivRank <= 75) regime = 'elevated';
        else regime = 'rich';
        return `ATM IV ${ivPct}% (rank ${a.ivRank.toFixed(0)} → ${regime})`;
    }
    if (a.ivHvRatio != null) {
        let regime;
        if (a.ivHvRatio < 1.0) regime = 'cheap vs realized';
        else if (a.ivHvRatio < 1.3) regime = 'fair vs realized';
        else if (a.ivHvRatio < 1.6) regime = 'elevated vs realized';
        else regime = 'rich vs realized';
        return `ATM IV ${ivPct}% / HV ${a.vol20.toFixed(0)}% = ${a.ivHvRatio.toFixed(2)}x (${regime}, rank building)`;
    }
    return `ATM IV ${ivPct}%`;
}

function buildThesis(a, side) {
    const parts = [
        `${a.symbol} @ $${a.last.toFixed(2)}`,
        `RSI(14) ${a.rsi != null ? a.rsi.toFixed(1) : 'n/a'}`,
        `${a.distFromMaPct >= 0 ? '+' : ''}${a.distFromMaPct?.toFixed(1)}% vs 50d MA`,
        `20d return ${a.mom20 >= 0 ? '+' : ''}${a.mom20?.toFixed(1)}%`,
        `realized vol (20d) ${a.vol20?.toFixed(0)}%`,
        `${a.distFromHighPct >= 0 ? '+' : ''}${a.distFromHighPct?.toFixed(1)}% from 60d high`,
    ];
    const iv = ivLabel(a);
    if (iv) parts.push(iv);

    // Strategy hint depends on IV regime — debit when premium is cheap/fair, fade size when rich
    const richIv = (a.ivRank != null && a.ivSampleCount >= 30 && a.ivRank >= 65) ||
                   (a.ivHvRatio != null && a.ivHvRatio >= 1.4);
    const cheapIv = (a.ivRank != null && a.ivSampleCount >= 30 && a.ivRank <= 35) ||
                    (a.ivHvRatio != null && a.ivHvRatio < 1.05);

    if (side === 'bearish') {
        let strat;
        if (cheapIv) strat = 'put debit spread is cheap here — favorable risk/reward.';
        else if (richIv) strat = 'premium is rich — size down or wait, OR consider a bear call credit spread to harvest IV.';
        else strat = 'defined-risk put debit spread is reasonable.';
        return `BEARISH SETUP — ${parts.join(' | ')}. Looks overextended; ${strat} Max loss = premium paid.`;
    } else {
        let strat;
        if (cheapIv) strat = 'call debit spread is cheap here — favorable risk/reward.';
        else if (richIv) strat = 'premium is rich — size down or wait, OR consider a bull put credit spread to harvest IV.';
        else strat = 'long call or call debit spread is reasonable.';
        return `BULLISH SETUP — ${parts.join(' | ')}. Constructive pullback in an uptrend; ${strat} Max loss = premium paid.`;
    }
}

function buildInvalidation(a, side) {
    if (side === 'bearish') {
        return `Invalidates if ${a.symbol} closes 3%+ above the recent 60d high ($${a.high60.toFixed(2)}) or if RSI rolls back below 60 with strength.`;
    }
    return `Invalidates if ${a.symbol} loses the 50d MA ($${a.ma50?.toFixed(2)}) on a daily close, or if RSI breaks below 35.`;
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
    // CORS preflight (admin page is same-origin in prod, but be permissive for testing)
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    // Auth — accept either the trigger token (machine) or admin password (UI)
    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const expectedAdminPw = process.env.ADMIN_PASSWORD;
    const okByTrigger = expectedTrigger && trigger === expectedTrigger;
    const okByAdmin = expectedAdminPw && adminPw === expectedAdminPw;
    if (!okByTrigger && !okByAdmin) {
        return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Use Alpaca's IEX feed (free on paper). The bars endpoint needs an
        // explicit `start` — `limit` alone only returns the latest bar.
        // 120 calendar days ≈ ~85 trading days, plenty for 50d MA + 20d momentum.
        const symbols = UNIVERSE.join(',');
        const dataBaseUrl = 'https://data.alpaca.markets';
        const startDate = new Date(Date.now() - 120 * 86400000).toISOString().split('T')[0];
        const url = `${dataBaseUrl}/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&start=${startDate}&limit=10000&adjustment=raw&feed=iex`;

        const start = Date.now();
        const resp = await fetch(url, {
            headers: {
                'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
                'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                'Accept': 'application/json',
            },
        });
        const requestId = resp.headers.get('x-request-id');
        const durationMs = Date.now() - start;

        if (!resp.ok) {
            const errText = await resp.text();
            await logAlpacaCall({
                method: 'GET', path: '/v2/stocks/bars', status_code: resp.status,
                request_id: requestId, duration_ms: durationMs, error: errText.slice(0, 300),
            }).catch(() => {});
            return {
                statusCode: 502,
                body: JSON.stringify({ ok: false, error: 'Alpaca bars fetch failed', status: resp.status, request_id: requestId, alpaca: errText.slice(0, 300) }),
            };
        }

        const data = await resp.json();
        await logAlpacaCall({
            method: 'GET', path: '/v2/stocks/bars', status_code: 200,
            request_id: requestId, duration_ms: durationMs, error: null,
        }).catch(() => {});

        // Analyze each symbol
        const analyses = [];
        for (const symbol of UNIVERSE) {
            const bars = data.bars?.[symbol];
            const a = analyze(symbol, bars);
            if (a) analyses.push(a);
        }

        if (analyses.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'No usable bar data — market may be closed or feed empty', request_id: requestId }) };
        }

        // ── VIX market-wide regime (parallel to per-symbol IV work) ──
        const vixPromise = fetchVixHistory()
            .then(h => computeVixRegime(h, 252))
            .catch(err => { console.warn('VIX fetch failed:', err.message); return null; });

        // ── IV enrichment: ATM ~30DTE call+put → atm_iv, iv/hv ratio, rolling rank ──
        // Step 1: in parallel, find ATM call+put contracts per symbol
        const atmPicks = await Promise.all(analyses.map(a =>
            findAtmStraddle(a.symbol, a.last).catch(() => ({ callPick: null, putPick: null }))
        ));

        // Step 2: collect all chosen contract symbols, fetch IV in batched snapshots
        const contractSymbols = [];
        for (const pick of atmPicks) {
            if (pick.callPick) contractSymbols.push(pick.callPick.contract.symbol);
            if (pick.putPick) contractSymbols.push(pick.putPick.contract.symbol);
        }
        const snapshots = await fetchOptionSnapshots(contractSymbols).catch(() => ({}));

        // Step 3: pull historical IV per symbol so we can compute rolling rank/percentile
        const todayDate = new Date().toISOString().split('T')[0];
        const lookbackStart = new Date(Date.now() - 252 * 86400000).toISOString().split('T')[0];
        let history = [];
        try {
            history = await supabaseSelect('iv_history',
                `select=symbol,captured_date,atm_iv&symbol=in.(${analyses.map(a => a.symbol).join(',')})&captured_date=gte.${lookbackStart}&captured_date=lt.${todayDate}&order=captured_date.desc`
            );
        } catch (err) {
            console.warn('iv_history select failed:', err.message);
        }
        const histBySymbol = {};
        for (const row of history) {
            (histBySymbol[row.symbol] = histBySymbol[row.symbol] || []).push(row);
        }

        // Step 4: enrich each analysis with IV stats + queue today's reading for upsert
        const ivRowsToWrite = [];
        for (let i = 0; i < analyses.length; i++) {
            const a = analyses[i];
            const pick = atmPicks[i];
            const callSnap = pick.callPick ? snapshots[pick.callPick.contract.symbol] : null;
            const putSnap = pick.putPick ? snapshots[pick.putPick.contract.symbol] : null;
            const callIv = callSnap?.impliedVolatility ?? callSnap?.greeks?.impliedVolatility ?? null;
            const putIv = putSnap?.impliedVolatility ?? putSnap?.greeks?.impliedVolatility ?? null;
            const ivs = [callIv, putIv].filter(v => typeof v === 'number' && v > 0);
            if (ivs.length === 0) {
                a.atmIv = null;
                a.ivHvRatio = null;
                a.ivRank = null;
                a.ivPercentile = null;
                a.ivSampleCount = 0;
                continue;
            }
            const atmIv = ivs.reduce((x, y) => x + y, 0) / ivs.length;
            const hvDecimal = a.vol20 != null ? a.vol20 / 100 : null;
            const ivHvRatio = hvDecimal && hvDecimal > 0 ? atmIv / hvDecimal : null;
            const expiry = (pick.callPick || pick.putPick).expiry;
            const dteUsed = (pick.callPick || pick.putPick).dte;

            const { rank, percentile, sampleCount } = computePercentile(histBySymbol[a.symbol] || [], atmIv);

            a.atmIv = atmIv;
            a.ivHvRatio = ivHvRatio;
            a.ivRank = rank;
            a.ivPercentile = percentile;
            a.ivSampleCount = sampleCount || 0;
            a.ivExpiryUsed = expiry;
            a.ivDteUsed = dteUsed;

            ivRowsToWrite.push({
                captured_date: todayDate,
                symbol: a.symbol,
                underlying_price: +a.last.toFixed(4),
                atm_iv: +atmIv.toFixed(4),
                expiry_used: expiry,
                dte_used: dteUsed,
                hv_20d: hvDecimal != null ? +hvDecimal.toFixed(4) : null,
                iv_hv_ratio: ivHvRatio != null ? +ivHvRatio.toFixed(3) : null,
                iv_rank: rank,
                iv_percentile: percentile,
                sample_count: sampleCount || 0,
            });
        }

        // Persist today's IV readings (upsert, one per symbol+date)
        if (ivRowsToWrite.length > 0) {
            await supabaseUpsert('iv_history', ivRowsToWrite, 'symbol,captured_date')
                .catch(err => console.warn('iv_history upsert failed:', err.message));
        }

        // Score and pick top 3 each side
        const bearish = analyses.map(a => ({ ...a, score: scoreBearish(a) }))
            .filter(a => a.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        const bullish = analyses.map(a => ({ ...a, score: scoreBullish(a) }))
            .filter(a => a.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        function ivTag(a) {
            if (a.ivRank != null && a.ivSampleCount >= 30) {
                if (a.ivRank <= 25) return 'iv_cheap';
                if (a.ivRank >= 75) return 'iv_rich';
                return 'iv_fair';
            }
            if (a.ivHvRatio != null) {
                if (a.ivHvRatio < 1.0) return 'iv_cheap';
                if (a.ivHvRatio > 1.5) return 'iv_rich';
                return 'iv_fair';
            }
            return null;
        }

        // Write to trade_ideas
        const ideas = [];
        for (const a of bearish) {
            const tags = ['screener_v2', 'bearish'];
            const t = ivTag(a); if (t) tags.push(t);
            ideas.push({
                status: 'idea',
                symbol: a.symbol,
                strategy: 'directional_bearish',
                thesis: buildThesis(a, 'bearish'),
                invalidation: buildInvalidation(a, 'bearish'),
                tags,
            });
        }
        for (const a of bullish) {
            const tags = ['screener_v2', 'bullish'];
            const t = ivTag(a); if (t) tags.push(t);
            ideas.push({
                status: 'idea',
                symbol: a.symbol,
                strategy: 'directional_bullish',
                thesis: buildThesis(a, 'bullish'),
                invalidation: buildInvalidation(a, 'bullish'),
                tags,
            });
        }

        if (ideas.length > 0) {
            await supabaseInsert('trade_ideas', ideas);
        }

        const summarize = (b) => ({
            symbol: b.symbol,
            score: +b.score.toFixed(1),
            rsi: b.rsi?.toFixed(1),
            dist_ma: b.distFromMaPct?.toFixed(1),
            mom20: b.mom20?.toFixed(1),
            iv: b.atmIv != null ? +(b.atmIv * 100).toFixed(1) : null,
            iv_hv: b.ivHvRatio != null ? +b.ivHvRatio.toFixed(2) : null,
            iv_rank: b.ivRank,
            iv_n: b.ivSampleCount,
        });

        const vix = await vixPromise;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                request_id: requestId,
                analyzed: analyses.length,
                iv_readings: ivRowsToWrite.length,
                ideas_written: ideas.length,
                market: vix ? { vix } : null,
                bearish: bearish.map(summarize),
                bullish: bullish.map(summarize),
            }, null, 2),
        };
    } catch (err) {
        console.error('screener error', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, request_id: err.requestId || null }) };
    }
};
