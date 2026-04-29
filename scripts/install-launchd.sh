#!/bin/bash
# One-shot installer for the trade-exit launchd job on macOS.
#
# Run this on the Mac mini (the machine that should host the cron):
#   bash scripts/install-launchd.sh
#
# What it does:
#   1. Creates the logs/ directory
#   2. Copies the plist into ~/Library/LaunchAgents/
#   3. Loads it via launchctl (starts the job, runs once at load)
#
# To uninstall later:
#   launchctl unload ~/Library/LaunchAgents/com.filmtranspo.trade-exit.plist
#   rm ~/Library/LaunchAgents/com.filmtranspo.trade-exit.plist

set -euo pipefail

REPO_DIR="/Users/stevendocherty/Projects/transportation-website"
PLIST_NAME="com.filmtranspo.trade-exit.plist"
SRC_PLIST="$REPO_DIR/scripts/$PLIST_NAME"
DEST_PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_DIR="$REPO_DIR/logs"

# Sanity checks
if [ ! -f "$SRC_PLIST" ]; then
    echo "ERROR: plist not found at $SRC_PLIST"
    exit 1
fi
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node not on PATH. Install Node.js first."
    exit 1
fi
if ! command -v netlify >/dev/null 2>&1; then
    echo "ERROR: netlify CLI not on PATH. Install with: npm i -g netlify-cli"
    exit 1
fi

# 1. Logs directory
mkdir -p "$LOG_DIR"
echo "  ✓ logs dir ready: $LOG_DIR"

# 2. Copy plist
mkdir -p "$HOME/Library/LaunchAgents"
cp "$SRC_PLIST" "$DEST_PLIST"
echo "  ✓ plist installed: $DEST_PLIST"

# 3. Unload if previously loaded (clean re-install)
launchctl unload "$DEST_PLIST" 2>/dev/null || true

# 4. Load it
launchctl load "$DEST_PLIST"
echo "  ✓ launchd job loaded"

# 5. Confirm
echo ""
echo "── Status ─────────────────────────────────────"
launchctl list | grep com.filmtranspo.trade-exit || echo "  (not yet listed — try again in 5s)"
echo ""
echo "── First run output (wait ~10s, then tail) ───"
echo "  tail -f $LOG_DIR/trade-exit.out.log"
echo "  tail -f $LOG_DIR/trade-exit.err.log"
echo ""
echo "── Manual run (skips market-hours gate) ──────"
echo "  cd $REPO_DIR && FORCE_RUN=1 netlify dev:exec node scripts/trade-exit-runner.js"
echo ""
echo "Done. Job runs every 30 min and self-gates to market hours (10am–3:30pm ET, weekdays)."
