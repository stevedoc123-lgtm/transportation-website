#!/usr/bin/env node
/**
 * Mac mini cron runner for trade-exit.
 *
 * Imports the shared core and runs one pass. Logs summary to stdout (which
 * launchd captures to a file) and writes a heartbeat row to Supabase.
 *
 * Run:
 *   netlify dev:exec node scripts/trade-exit-runner.js
 *
 * Schedule (via launchd, see scripts/install-launchd.sh):
 *   Every 30 min, weekdays, 10:00–15:30 ET.
 *
 * Skips itself outside US equity market hours so launchd can run on a simple
 * StartInterval and the script self-gates the active window.
 */

const { runTradeExit, recordRun } = require('../netlify/functions/_lib/trade-exit-core');

function isMarketOpenNow() {
    const now = new Date();
    // Convert to America/New_York
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const weekday = parts.weekday;                                     // e.g. 'Mon'
    if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;
    const hh = parseInt(parts.hour, 10);
    const mm = parseInt(parts.minute, 10);
    const minutes = hh * 60 + mm;
    // Active window: 10:00 ET → 15:30 ET (skip first 30 min of open and last 30 min of close).
    return minutes >= 600 && minutes <= 930;
}

(async () => {
    const startedAtIso = new Date().toISOString();
    const skip = !isMarketOpenNow() && !process.env.FORCE_RUN;
    if (skip) {
        console.log(`[${startedAtIso}] outside market hours — skipping (set FORCE_RUN=1 to override)`);
        process.exit(0);
    }

    if (!process.env.ALPACA_KEY_ID || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error(`[${startedAtIso}] missing env vars. Run via: netlify dev:exec node scripts/trade-exit-runner.js`);
        process.exit(1);
    }

    const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
    console.log(`[${startedAtIso}] trade-exit-runner starting (Mac mini cron)${dryRun ? ' [DRY RUN]' : ''}`);
    const summary = await runTradeExit({ source: 'mac-mini-cron', dryRun });

    console.log(JSON.stringify({
        ok: summary.ok,
        evaluated: summary.evaluated_count ?? 0,
        peak_updates: summary.peak_updates ?? 0,
        closed: summary.closed_count ?? 0,
        skipped: summary.skipped_count ?? 0,
        errors: summary.errors?.length ?? 0,
        note: summary.note,
        first_close: summary.closed?.[0],
    }, null, 2));

    await recordRun('trade-exit', 'mac-mini-cron', summary).catch(err => {
        console.warn(`heartbeat failed: ${err.message}`);
    });

    process.exit(summary.ok ? 0 : 1);
})().catch(err => {
    console.error('fatal:', err.message);
    process.exit(2);
});
