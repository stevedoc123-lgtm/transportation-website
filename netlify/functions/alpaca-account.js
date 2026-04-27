/**
 * GET /.netlify/functions/alpaca-account
 *
 * Verifies the Alpaca env vars are wired correctly by hitting /v2/account
 * and returning a sanitized snapshot of the account state.
 *
 * Logs the X-Request-ID per Alpaca's recommendation so we can hand it to
 * support if anything goes sideways.
 *
 * Required env vars (set in Netlify):
 *   ALPACA_KEY_ID
 *   ALPACA_SECRET_KEY
 *   ALPACA_BASE_URL  (e.g. https://paper-api.alpaca.markets)
 */

exports.handler = async (event) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    const { ALPACA_KEY_ID, ALPACA_SECRET_KEY, ALPACA_BASE_URL } = process.env;
    if (!ALPACA_KEY_ID || !ALPACA_SECRET_KEY || !ALPACA_BASE_URL) {
        return {
            statusCode: 500,
            headers: cors,
            body: JSON.stringify({
                ok: false,
                error: 'Missing Alpaca env vars',
                missing: {
                    ALPACA_KEY_ID: !ALPACA_KEY_ID,
                    ALPACA_SECRET_KEY: !ALPACA_SECRET_KEY,
                    ALPACA_BASE_URL: !ALPACA_BASE_URL,
                },
            }),
        };
    }

    const start = Date.now();
    try {
        const resp = await fetch(`${ALPACA_BASE_URL}/v2/account`, {
            method: 'GET',
            headers: {
                'APCA-API-KEY-ID': ALPACA_KEY_ID,
                'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY,
                'Accept': 'application/json',
            },
        });

        const requestId = resp.headers.get('x-request-id') || null;
        const durationMs = Date.now() - start;
        const bodyText = await resp.text();

        if (!resp.ok) {
            console.error('Alpaca /v2/account failed', resp.status, requestId, bodyText);
            return {
                statusCode: 502,
                headers: cors,
                body: JSON.stringify({
                    ok: false,
                    error: 'Alpaca API returned non-2xx',
                    status: resp.status,
                    request_id: requestId,
                    duration_ms: durationMs,
                    alpaca_body: bodyText.slice(0, 500),
                }),
            };
        }

        const account = JSON.parse(bodyText);

        // Pick only the fields useful for verifying the wiring works. We
        // don't echo the full payload because it's noisy.
        const summary = {
            ok: true,
            request_id: requestId,
            duration_ms: durationMs,
            base_url: ALPACA_BASE_URL,
            paper: ALPACA_BASE_URL.includes('paper-api'),
            account: {
                account_number: account.account_number,
                status: account.status,
                currency: account.currency,
                cash: account.cash,
                buying_power: account.buying_power,
                portfolio_value: account.portfolio_value,
                equity: account.equity,
                options_trading_level: account.options_trading_level,
                options_buying_power: account.options_buying_power,
                crypto_status: account.crypto_status,
                shorting_enabled: account.shorting_enabled,
                pattern_day_trader: account.pattern_day_trader,
                trading_blocked: account.trading_blocked,
                created_at: account.created_at,
            },
        };

        return {
            statusCode: 200,
            headers: { ...cors, 'Content-Type': 'application/json' },
            body: JSON.stringify(summary, null, 2),
        };
    } catch (err) {
        console.error('alpaca-account function error', err);
        return {
            statusCode: 500,
            headers: cors,
            body: JSON.stringify({ ok: false, error: err.message }),
        };
    }
};
