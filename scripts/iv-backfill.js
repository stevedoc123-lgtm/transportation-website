#!/usr/bin/env node
/**
 * One-shot IV history backfill — PARKED.
 *
 * REQUIRES ALPACA ALGO TRADER PLUS SUBSCRIPTION (~$99/mo) FOR OPRA ACCESS.
 * The Basic (free) plan returns 403 "OPRA agreement is not signed" on
 * /v1beta1/options/bars. The screener's daily collector works fine on the
 * free indicative feed (snapshots), so we collect IV history forward and
 * compute IV rank once enough days accumulate (~30 days for rough
 * percentile, ~252 for true 52w rank). This script is kept in case the
 * subscription is ever upgraded.
 *
 * For each symbol in UNIVERSE, walks the past ~252 trading days, picks the
 * ATM straddle (~30 DTE next monthly expiry) for each day, fetches its
 * daily bars from Alpaca, back-solves Black-Scholes IV from the close, and
 * upserts one iv_history row per (symbol, date).
 *
 * Run from the repo root:
 *   netlify dev:exec node scripts/iv-backfill.js
 *
 * Reads env: ALPACA_KEY_ID, ALPACA_SECRET_KEY, ALPACA_BASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Notes:
 * - Alpaca historical option data starts Feb 2024. We cap lookback there.
 * - Risk-free rate is held constant (5%); for IV-rank purposes the absolute
 *   level doesn't matter, only the relative day-over-day movement.
 * - Dividend yield is assumed 0 — slightly biases call/put IV but the
 *   bias is constant per symbol so cancels out in rank.
 * - Optional CLI flags: --symbols=AAPL,MSFT (default = full universe),
 *                        --days=252 (default lookback in trading days)
 */

const SUPABASE_URL = 'https://dshhqozxeaetzenekzqr.supabase.co';

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

const RISK_FREE_RATE = 0.05;
const TRADING_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';
const ALPACA_HIST_FLOOR = '2024-02-01';

// CLI args
const args = Object.fromEntries(process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const SYMBOLS = args.symbols ? args.symbols.split(',').map(s => s.toUpperCase()) : UNIVERSE;
const LOOKBACK_DAYS = parseInt(args.days || '252', 10);

// ── Black-Scholes ──────────────────────────────────────────────────────────

function normCdf(x) {
    // Abramowitz & Stegun 7.1.26
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x) / Math.SQRT2;
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return 0.5 * (1.0 + sign * y);
}

function bsPrice(S, K, T, r, sigma, isCall) {
    if (T <= 0 || sigma <= 0) return Math.max(0, isCall ? S - K : K - S);
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    if (isCall) return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
    return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

function bsImpliedVol(price, S, K, T, r, isCall) {
    // Drop options trading below intrinsic + 1¢ — IV undefined / arbitrage
    const intrinsic = Math.max(0, isCall ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S);
    if (price <= intrinsic + 0.01) return null;
    let lo = 0.01, hi = 5.0;
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        const p = bsPrice(S, K, T, r, mid, isCall);
        if (p > price) hi = mid; else lo = mid;
        if (hi - lo < 1e-5) break;
    }
    const sigma = (lo + hi) / 2;
    if (sigma >= 4.99 || sigma <= 0.011) return null; // bisection hit a rail
    return sigma;
}

// ── Alpaca helpers ─────────────────────────────────────────────────────────

const alpacaHeaders = () => ({
    'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Accept': 'application/json',
});

const DEBUG = process.env.DEBUG === '1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Throttle: Alpaca paper allows 200 req/min. Spread at ~3/sec with auto-retry on 429.
const MIN_INTERVAL_MS = 350;
let _lastCallAt = 0;

async function alpacaJson(url, attempt = 0) {
    const now = Date.now();
    const wait = Math.max(0, _lastCallAt + MIN_INTERVAL_MS - now);
    if (wait > 0) await sleep(wait);
    _lastCallAt = Date.now();

    const r = await fetch(url, { headers: alpacaHeaders() });
    if (r.status === 429 && attempt < 5) {
        const backoff = 2000 * (attempt + 1);
        if (DEBUG) console.log(`    [429] backing off ${backoff}ms then retry`);
        await sleep(backoff);
        return alpacaJson(url, attempt + 1);
    }
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`${r.status} ${url.slice(0, 120)}: ${t.slice(0, 200)}`);
    }
    return r.json();
}

async function getStockBars(symbol, startDate, endDate) {
    const url = `${DATA_BASE}/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&start=${startDate}&end=${endDate}&limit=10000&adjustment=raw&feed=iex`;
    const j = await alpacaJson(url);
    return (j.bars?.[symbol] || []).map(b => ({ date: b.t.slice(0, 10), close: b.c }));
}

async function listContractsForStatus(symbol, side, status, expirationGte, expirationLte) {
    const all = [];
    let pageToken = null;
    for (let i = 0; i < 20; i++) {
        const params = new URLSearchParams({
            underlying_symbols: symbol,
            type: side,
            status,
            expiration_date_gte: expirationGte,
            expiration_date_lte: expirationLte,
            limit: '1000',
        });
        if (pageToken) params.set('page_token', pageToken);
        const j = await alpacaJson(`${TRADING_BASE}/v2/options/contracts?${params}`);
        if (j.option_contracts) all.push(...j.option_contracts);
        pageToken = j.next_page_token;
        if (!pageToken) break;
    }
    return all;
}

async function listContracts(symbol, side, expirationGte, expirationLte) {
    const [active, inactive] = [
        await listContractsForStatus(symbol, side, 'active', expirationGte, expirationLte),
        await listContractsForStatus(symbol, side, 'inactive', expirationGte, expirationLte),
    ];
    if (DEBUG) console.log(`    listContracts ${symbol} ${side}: ${active.length} active + ${inactive.length} inactive = ${active.length + inactive.length}`);
    return [...active, ...inactive];
}

async function getOptionBars(contractSymbols, startDate, endDate) {
    // Multi-symbol queries hit OPRA gating (403). Single-symbol works on the free
    // indicative tier. So we fetch one contract at a time — slower but no paid plan.
    const out = {};
    let i = 0;
    let withBars = 0;
    let empty = 0;
    let failed = 0;
    for (const sym of contractSymbols) {
        i++;
        let pageToken = null;
        let bars = [];
        try {
            for (let p = 0; p < 5; p++) {
                const params = new URLSearchParams({
                    symbols: sym,
                    timeframe: '1Day',
                    start: startDate,
                    end: endDate,
                    limit: '10000',
                });
                if (pageToken) params.set('page_token', pageToken);
                const j = await alpacaJson(`${DATA_BASE}/v1beta1/options/bars?${params}`);
                if (j.bars && j.bars[sym]) bars.push(...j.bars[sym]);
                pageToken = j.next_page_token;
                if (!pageToken) break;
            }
        } catch (e) {
            failed++;
            if (DEBUG) console.log(`    bars ${sym} failed: ${e.message.slice(0, 100)}`);
            continue;
        }
        if (bars.length > 0) { out[sym] = bars; withBars++; } else { empty++; }
        if (DEBUG && i % 25 === 0) {
            console.log(`    bars progress: ${i}/${contractSymbols.length}, withBars=${withBars}, empty=${empty}, failed=${failed}`);
        }
    }
    if (DEBUG) console.log(`    bars done: ${withBars} with data, ${empty} empty, ${failed} errored`);
    return out;
}

// ── Date helpers ───────────────────────────────────────────────────────────

function thirdFriday(year, month) {
    // month is 1-12
    const d = new Date(Date.UTC(year, month - 1, 1));
    // Find first Friday
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + 14); // jump to 3rd Friday
    return d.toISOString().slice(0, 10);
}

function nextMonthlyExpiry(fromDateStr, minDte = 25) {
    const from = new Date(fromDateStr + 'T00:00:00Z');
    const minTarget = new Date(from.getTime() + minDte * 86400000);
    let y = minTarget.getUTCFullYear(), m = minTarget.getUTCMonth() + 1;
    for (let i = 0; i < 4; i++) {
        const candidate = thirdFriday(y, m);
        if (new Date(candidate + 'T16:00:00Z') >= minTarget) return candidate;
        m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return null;
}

function daysBetween(fromStr, toStr) {
    const a = new Date(fromStr + 'T16:00:00Z').getTime();
    const b = new Date(toStr + 'T16:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
}

// ── HV ──────────────────────────────────────────────────────────────────────

function realizedVol(closes, n) {
    if (closes.length < n + 1) return null;
    const rets = [];
    for (let i = closes.length - n; i < closes.length; i++) {
        rets.push(Math.log(closes[i] / closes[i - 1]));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    return Math.sqrt(variance) * Math.sqrt(252);
}

// ── Supabase ───────────────────────────────────────────────────────────────

async function supabaseUpsert(table, rows, onConflict) {
    if (!rows.length) return;
    // Chunk to keep request body sane
    for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
            method: 'POST',
            headers: {
                apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal,resolution=merge-duplicates',
            },
            body: JSON.stringify(chunk),
        });
        if (!r.ok) throw new Error(`Supabase upsert ${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
}

// ── Per-symbol backfill ────────────────────────────────────────────────────

async function backfillSymbol(symbol) {
    const today = new Date().toISOString().slice(0, 10);
    // 365 calendar days back ≈ 252 trading days, with buffer for HV calc
    const startCalendar = new Date(Date.now() - (LOOKBACK_DAYS + 35) * (365 / 252) * 86400000)
        .toISOString().slice(0, 10);
    const stockStart = startCalendar < ALPACA_HIST_FLOOR ? ALPACA_HIST_FLOOR : startCalendar;

    const stockBars = await getStockBars(symbol, stockStart, today);
    if (stockBars.length < 30) {
        console.log(`  ${symbol}: not enough stock bars (${stockBars.length}), skipping`);
        return { written: 0 };
    }
    const closesByDate = Object.fromEntries(stockBars.map(b => [b.date, b.close]));

    // Target trading days = last LOOKBACK_DAYS bars (excluding the most recent ~3
    // since the screener's daily collector handles those going forward)
    const targetBars = stockBars.slice(-Math.min(LOOKBACK_DAYS + 1, stockBars.length), -3);
    if (targetBars.length === 0) return { written: 0 };

    // For each target day, compute target expiry → set of (date, expiry, spot)
    const dayPlans = [];
    const expirySet = new Set();
    for (const bar of targetBars) {
        const expiry = nextMonthlyExpiry(bar.date, 25);
        if (!expiry) continue;
        const dte = daysBetween(bar.date, expiry);
        if (dte > 50) continue;
        dayPlans.push({ date: bar.date, expiry, spot: bar.close, dte });
        expirySet.add(expiry);
    }
    if (dayPlans.length === 0) return { written: 0 };

    const expiryList = Array.from(expirySet).sort();
    const minExpiry = expiryList[0], maxExpiry = expiryList[expiryList.length - 1];

    // List contracts covering all target expiries (one wide query per side)
    const [calls, puts] = await Promise.all([
        listContracts(symbol, 'call', minExpiry, maxExpiry),
        listContracts(symbol, 'put', minExpiry, maxExpiry),
    ]);
    if (!calls.length && !puts.length) {
        console.log(`  ${symbol}: no contracts found in range`);
        return { written: 0 };
    }

    // Group by expiration date
    const callsByExpiry = {}, putsByExpiry = {};
    for (const c of calls) (callsByExpiry[c.expiration_date] = callsByExpiry[c.expiration_date] || []).push(c);
    for (const p of puts)  (putsByExpiry[p.expiration_date]  = putsByExpiry[p.expiration_date]  || []).push(p);

    // For each day plan, pick ATM call & put at that day's spot
    const wantedContracts = new Set();
    const dayPicks = [];
    for (const plan of dayPlans) {
        const callList = callsByExpiry[plan.expiry] || [];
        const putList = putsByExpiry[plan.expiry] || [];
        if (!callList.length && !putList.length) continue;
        const closestCall = callList.length ? callList.reduce((a, b) =>
            Math.abs(parseFloat(a.strike_price) - plan.spot) < Math.abs(parseFloat(b.strike_price) - plan.spot) ? a : b
        ) : null;
        const closestPut = putList.length ? putList.reduce((a, b) =>
            Math.abs(parseFloat(a.strike_price) - plan.spot) < Math.abs(parseFloat(b.strike_price) - plan.spot) ? a : b
        ) : null;
        if (!closestCall && !closestPut) continue;
        if (closestCall) wantedContracts.add(closestCall.symbol);
        if (closestPut) wantedContracts.add(closestPut.symbol);
        dayPicks.push({
            ...plan,
            call: closestCall ? { symbol: closestCall.symbol, strike: parseFloat(closestCall.strike_price) } : null,
            put: closestPut ? { symbol: closestPut.symbol, strike: parseFloat(closestPut.strike_price) } : null,
        });
    }

    // Fetch bars for all wanted contracts (covers all target dates, one query per chunk)
    const wantedArr = Array.from(wantedContracts);
    const optionBars = await getOptionBars(wantedArr, stockStart, today);
    // Index bars by (contractSymbol, date)
    const barLookup = {};
    for (const [csym, bars] of Object.entries(optionBars)) {
        for (const b of bars) {
            barLookup[`${csym}|${b.t.slice(0, 10)}`] = b.c;
        }
    }

    // Compute IV per day
    const closesArr = stockBars.map(b => b.close);
    const datesArr = stockBars.map(b => b.date);
    const dateToIdx = Object.fromEntries(datesArr.map((d, i) => [d, i]));

    const rows = [];
    let solved = 0;
    for (const pick of dayPicks) {
        const T = Math.max(daysBetween(pick.date, pick.expiry), 1) / 365;
        const callPrice = pick.call ? barLookup[`${pick.call.symbol}|${pick.date}`] : null;
        const putPrice = pick.put ? barLookup[`${pick.put.symbol}|${pick.date}`] : null;
        const callIv = (callPrice && pick.call) ? bsImpliedVol(callPrice, pick.spot, pick.call.strike, T, RISK_FREE_RATE, true) : null;
        const putIv = (putPrice && pick.put) ? bsImpliedVol(putPrice, pick.spot, pick.put.strike, T, RISK_FREE_RATE, false) : null;
        const ivs = [callIv, putIv].filter(v => v != null);
        if (ivs.length === 0) continue;
        const atmIv = ivs.reduce((a, b) => a + b, 0) / ivs.length;
        solved++;

        // 20d HV ending on this date
        const idx = dateToIdx[pick.date];
        let hv = null;
        if (idx != null && idx >= 20) {
            hv = realizedVol(closesArr.slice(0, idx + 1), 20);
        }

        rows.push({
            captured_date: pick.date,
            symbol,
            underlying_price: +pick.spot.toFixed(4),
            atm_iv: +atmIv.toFixed(4),
            expiry_used: pick.expiry,
            dte_used: pick.dte,
            hv_20d: hv != null ? +hv.toFixed(4) : null,
            iv_hv_ratio: (hv != null && hv > 0) ? +(atmIv / hv).toFixed(3) : null,
            iv_rank: null,
            iv_percentile: null,
            sample_count: 0,
        });
    }

    await supabaseUpsert('iv_history', rows, 'symbol,captured_date');
    console.log(`  ${symbol}: ${dayPicks.length} day-picks, ${solved} solved, ${rows.length} rows written`);
    return { written: rows.length };
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
    if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
        console.error('Missing ALPACA_KEY_ID / ALPACA_SECRET_KEY env vars.');
        console.error('Run via: netlify env:exec node scripts/iv-backfill.js');
        process.exit(1);
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing SUPABASE_SERVICE_ROLE_KEY env var.');
        process.exit(1);
    }
    console.log(`IV backfill: ${SYMBOLS.length} symbols, ${LOOKBACK_DAYS} trading days lookback`);
    console.log(`Alpaca base: ${TRADING_BASE}\n`);

    let totalRows = 0;
    const startedAt = Date.now();
    for (const sym of SYMBOLS) {
        const t0 = Date.now();
        try {
            const res = await backfillSymbol(sym);
            totalRows += res.written;
            console.log(`  → ${sym} done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
        } catch (e) {
            console.error(`  ! ${sym} FAILED: ${e.message}\n`);
        }
    }
    console.log(`Done. ${totalRows} rows across ${SYMBOLS.length} symbols in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
})();
