/**
 * POST /.netlify/functions/trade-exit
 *
 * HTTP wrapper around the shared trade-exit-core. The actual logic lives in
 * netlify/functions/_lib/trade-exit-core.js so the Mac mini cron job can
 * import the same code (see scripts/trade-exit-runner.js).
 *
 * On Netlify this runs once a day as a scheduled-fn safety net (3:30 PM ET).
 * The Mac mini handles the high-frequency loop (every 30 min, market hours).
 *
 * Body (all optional):
 *   { dry_run: false,
 *     near_max_pct: 90,
 *     arm_trail_pct: 50,
 *     dte_threshold: 21 }
 *
 * Auth: X-Admin-Password, X-Trigger-Token, or Netlify Scheduled invoke.
 */

const { runTradeExit, recordRun } = require('./_lib/trade-exit-core');

exports.handler = async (event) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Trigger-Token, X-Admin-Password' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

    const adminPw = event.headers['x-admin-password'] || event.headers['X-Admin-Password'];
    const trigger = event.headers['x-trigger-token'] || event.headers['X-Trigger-Token'];
    const expectedAdmin = process.env.ADMIN_PASSWORD;
    const expectedTrigger = process.env.SCREENER_TOKEN || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const isScheduled = (event.headers['user-agent'] || '').includes('Netlify Functions Scheduled');
    const ok = isScheduled
        || (expectedAdmin && adminPw === expectedAdmin)
        || (expectedTrigger && trigger === expectedTrigger);
    if (!ok) return { statusCode: 401, headers: cors, body: JSON.stringify({ ok: false, error: 'unauthorized' }) };

    let cfg = {};
    try { cfg = event.body ? JSON.parse(event.body) : {}; } catch {}
    const source = isScheduled ? 'netlify-scheduled' : 'manual';

    const summary = await runTradeExit({
        dryRun: !!cfg.dry_run,
        nearMaxPct: cfg.near_max_pct,
        armTrailPct: cfg.arm_trail_pct,
        dteThreshold: cfg.dte_threshold,
        source,
    });

    // Heartbeat (best-effort; don't block on failure)
    if (!cfg.dry_run) {
        await recordRun('trade-exit', source, summary).catch(() => {});
    }

    return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(summary, null, 2),
    };
};

// Daily safety-net: weekdays 19:30 UTC (3:30 PM ET, 30 min before close).
// The Mac mini cron handles high-frequency runs; this is the backup if the
// mini is unreachable, asleep, or otherwise misses its schedule.
exports.config = {
    schedule: '30 19 * * 1-5',
};
