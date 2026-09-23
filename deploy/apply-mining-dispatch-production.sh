#!/usr/bin/env bash
# deploy/apply-mining-dispatch-production.sh
#
# One-shot script for whoever runs commands on the production droplet.
# Finishes the mining/dispatch production cutover that was done in the
# repo on 2026-09-23 (see docs/pm/RAID_LOG.md, item R-1) but could NOT be
# finished from a dev session with no SSH access to this droplet:
#
#   1. Pulls the latest code (the cutover + the backfill helper script).
#   2. Installs deps + runs any pending DB migrations (idempotent — safe
#      even if these already ran on a normal deploy).
#   3. Points ODOO_DISPATCH_URL / ODOO_DISPATCH_API_KEY / ODOO_MINING_URL
#      in backend/.env at the production ERP (erp.lakecement.co.tz),
#      backing up the old .env first. Every other line in .env is left
#      untouched.
#   4. Reloads the app (pm2) so the new .env takes effect.
#   5. Backfills mining + dispatch from Odoo production, 2026-03-01
#      through today, into THIS droplet's own database — the exact same
#      backfill already run and verified against the dev DB.
#   6. Prints a health check so you can see it actually worked.
#
# Run as the `deploy` user (the same one CI/CD's SSH deploy uses), on the
# droplet, with the production Odoo API key passed in (never hardcoded in
# this file — it's the same key already in ODOO_PRODUCTION_API_KEY, so you
# can also just read it off this droplet's own backend/.env):
#
#   ODOO_PROD_KEY=<the production ERP api_key> bash apply-mining-dispatch-production.sh
#
# Safe to re-run: every step here is idempotent (git reset, npm ci,
# npm run migrate, the .env patch, and the backfill's own upserts all are).

set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
ENV_FILE="$APP_DIR/backend/.env"

: "${ODOO_PROD_KEY:?Set ODOO_PROD_KEY to the production ERP api_key first, e.g.: ODOO_PROD_KEY=... bash $0}"

PROD_DISPATCH_URL="https://erp.lakecement.co.tz/dispatch_report"
PROD_DISPATCH_KEY="$ODOO_PROD_KEY"
PROD_MINING_URL="https://erp.lakecement.co.tz/mining_report"

echo "== 1/6  Pulling latest code =="
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main

echo
echo "== 2/6  Installing deps + running migrations =="
cd "$APP_DIR/backend"
npm ci --omit=dev
npm run migrate

echo
echo "== 3/6  Pointing dispatch/mining at production in backend/.env =="
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found — is APP_DIR correct? Aborting." >&2
  exit 1
fi

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
echo "  (backed up existing .env)"

set_env_var() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    echo "  updated $key"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    echo "  added $key (was missing)"
  fi
}

set_env_var ODOO_DISPATCH_URL     "$PROD_DISPATCH_URL"
set_env_var ODOO_DISPATCH_API_KEY "$PROD_DISPATCH_KEY"
set_env_var ODOO_MINING_URL       "$PROD_MINING_URL"
# ODOO_MINING_API_KEY is deliberately left alone — when unset it falls
# back to ODOO_DISPATCH_API_KEY, which is now correct (see
# backend/services/odooMiningClient.js).

echo
echo "== 4/6  Reloading the app so the new .env takes effect =="
pm2 reload "$APP_DIR/deploy/ecosystem.config.js" --update-env
sleep 3

echo
echo "== 5/6  Backfilling mining + dispatch from Odoo production (2026-03-01..today) =="
echo "        This can take several minutes — a month of mining data is ~10s."
cd "$APP_DIR/backend"
node scripts/odoo-mining-dispatch-backfill.js

echo
echo "== 6/6  Health check =="
PORT="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d'=' -f2)"
PORT="${PORT:-5000}"
curl -sS "http://localhost:${PORT}/api/health" | tee /dev/stderr | grep -q '"dispatch":"configured' \
  && echo "OK — dispatch/mining report as configured in /api/health" \
  || echo "WARNING: could not confirm from /api/health — check manually: curl localhost:${PORT}/api/health"

echo
echo "Done. Open the Dispatch report and Quarry dashboard (mines-report.html) to confirm real data shows."
