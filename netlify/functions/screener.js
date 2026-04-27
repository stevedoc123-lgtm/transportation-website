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

function scoreBearish(a) {
    // Reward overbought + extended above MA + steep recent momentum.
    let s = 0;
    if (a.rsi != null && a.rsi >= 70) s += (a.rsi - 70) * 2;
    if (a.distFromMaPct != null && a.distFromMaPct >= 8) s += (a.distFromMaPct - 8) * 1.5;
    if (a.mom20 != null && a.mom20 >= 10) s += (a.mom20 - 10);
    // Penalize names already pulling back hard from highs (the move may be done)
    if (a.distFromHighPct != null && a.distFromHighPct < -10) s -= 10;
    return s;
}

function scoreBullish(a) {
    // Reward uptrend (price > MA) but pulled back to a reasonable entry,
    // plus oversold-bouncing RSI.
    let s = 0;
    if (a.distFromMaPct != null && a.distFromMaPct >= -2 && a.distFromMaPct <= 8) {
        s += 10 - Math.abs(a.distFromMaPct - 3); // peak around price ~3% above MA
    }
    if (a.rsi != null && a.rsi >= 35 && a.rsi <= 55) s += (55 - Math.abs(a.rsi - 45));
    // Pullbacks within an uptrend: 5-15% off the 60d high is the sweet spot
    if (a.distFromHighPct != null && a.distFromHighPct <= -5 && a.distFromHighPct >= -15) {
        s += 8;
    }
    // Avoid clear downtrends
    if (a.distFromMaPct != null && a.distFromMaPct < -5) s -= 20;
    return s;
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
    if (side === 'bearish') {
        return `BEARISH SETUP — ${parts.join(' | ')}. Looks overextended; consider a defined-risk put debit spread or a long put on a weakness signal. Max loss = premium paid.`;
    } else {
        return `BULLISH SETUP — ${parts.join(' | ')}. In an uptrend with a constructive pullback; consider a long call or call debit spread targeting next leg up. Max loss = premium paid.`;
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
    // Auth
    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const expected = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!expected || trigger !== expected) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };
    }
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // Use Alpaca's IEX feed (free on paper) — pull 75 bars to compute 50d MA + 20d momentum
        const symbols = UNIVERSE.join(',');
        const dataBaseUrl = 'https://data.alpaca.markets';
        const url = `${dataBaseUrl}/v2/stocks/bars?symbols=${symbols}&timeframe=1Day&limit=75&adjustment=raw&feed=iex`;

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

        // Score and pick top 3 each side
        const bearish = analyses.map(a => ({ ...a, score: scoreBearish(a) }))
            .filter(a => a.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        const bullish = analyses.map(a => ({ ...a, score: scoreBullish(a) }))
            .filter(a => a.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);

        // Write to trade_ideas
        const ideas = [];
        for (const a of bearish) {
            ideas.push({
                status: 'idea',
                symbol: a.symbol,
                strategy: 'directional_bearish',
                thesis: buildThesis(a, 'bearish'),
                invalidation: buildInvalidation(a, 'bearish'),
                tags: ['screener_v1', 'bearish'],
            });
        }
        for (const a of bullish) {
            ideas.push({
                status: 'idea',
                symbol: a.symbol,
                strategy: 'directional_bullish',
                thesis: buildThesis(a, 'bullish'),
                invalidation: buildInvalidation(a, 'bullish'),
                tags: ['screener_v1', 'bullish'],
            });
        }

        if (ideas.length > 0) {
            await supabaseInsert('trade_ideas', ideas);
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ok: true,
                request_id: requestId,
                analyzed: analyses.length,
                ideas_written: ideas.length,
                bearish: bearish.map(b => ({ symbol: b.symbol, score: +b.score.toFixed(1), rsi: b.rsi?.toFixed(1), dist_ma: b.distFromMaPct?.toFixed(1), mom20: b.mom20?.toFixed(1) })),
                bullish: bullish.map(b => ({ symbol: b.symbol, score: +b.score.toFixed(1), rsi: b.rsi?.toFixed(1), dist_ma: b.distFromMaPct?.toFixed(1), mom20: b.mom20?.toFixed(1) })),
            }, null, 2),
        };
    } catch (err) {
        console.error('screener error', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message, request_id: err.requestId || null }) };
    }
};
