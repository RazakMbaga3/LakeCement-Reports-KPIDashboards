#!/usr/bin/env bash
# deploy/configure-odoo-production.sh
#
# One-shot script for whoever runs commands on the production droplet.
# Points ALL FIVE bespoke Odoo endpoints at the production ERP
# (erp.lakecement.co.tz) and backfills the two that mirror into this
# app's own Postgres. Confirmed by direct request 2026-09-23 that all
# five accept the SAME api_key on the SAME host:
#
#   production_report            (odoo_production_entries mirror)
#   sale_dashboard_report        (Sales dashboard, read live per request)
#   purchase_dashboard_report    (Purchases dashboard, read live per request)
#   dispatch_report               (weighbridge/Dispatch daily summary)
#   mining_report                 (Quarry weighbridge tickets)
#
# Why all five, not just dispatch/mining: docs/commit history claim
# production_report and the sales/purchases dashboard pair were already
# pointed at production on 2026-09-19/20 — but that could not be verified
# against this droplet's actual .env from a dev session with no SSH
# access to it, and a live discrepancy was already found in a DIFFERENT
# copy of this repo's .env (a dev machine's dashboard pair was still on
# the old test host despite docs saying otherwise). Rather than trust
# that documentation matches this droplet's real state, this script sets
# all five explicitly — safe either way, since it's idempotent and the
# values are the same ones already confirmed correct.
#
# What it does, in order:
#   1. Pulls the latest code.
#   2. Installs deps + runs any pending DB migrations (idempotent).
#   3. Points all five ODOO_* pairs in backend/.env at production,
#      backing up the old .env first. Every other line is left alone.
#   4. Reloads the app (pm2) so the new .env takes effect.
#   5. Backfills mining + dispatch from 2026-03-01 through today into
#      THIS droplet's own database (production_report and the dashboard
#      pair need no backfill here — production_report already mirrors
#      via its own daily cron once configured; the dashboard pair is
#      read live per request, nothing to store).
#   6. Prints a health check.
#
# Run as the `deploy` user, on the droplet, with the production Odoo API
# key passed in (never hardcoded in this file — it's the same key you'll
# find in this droplet's OWN backend/.env under ODOO_PRODUCTION_API_KEY,
# if production_report is already configured there):
#
#   ODOO_PROD_KEY=<the production ERP api_key> bash configure-odoo-production.sh
#
# Safe to re-run: every step here is idempotent.

set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
ENV_FILE="$APP_DIR/backend/.env"

: "${ODOO_PROD_KEY:?Set ODOO_PROD_KEY to the production ERP api_key first, e.g.: ODOO_PROD_KEY=... bash $0}"

PROD_HOST="https://erp.lakecement.co.tz"

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
echo "== 3/6  Pointing all five Odoo endpoints at production in backend/.env =="
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

set_env_var ODOO_PRODUCTION_URL     "${PROD_HOST}/production_report"
set_env_var ODOO_PRODUCTION_API_KEY "$ODOO_PROD_KEY"
set_env_var ODOO_DASHBOARD_URL      "$PROD_HOST"
set_env_var ODOO_DASHBOARD_API_KEY  "$ODOO_PROD_KEY"
set_env_var ODOO_DISPATCH_URL       "${PROD_HOST}/dispatch_report"
set_env_var ODOO_DISPATCH_API_KEY   "$ODOO_PROD_KEY"
set_env_var ODOO_MINING_URL         "${PROD_HOST}/mining_report"
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
HEALTH="$(curl -sS "http://localhost:${PORT}/api/health" || true)"
echo "$HEALTH"
if echo "$HEALTH" | grep -q '"dispatch":"configured'; then
  echo "OK — odoo checks report configured in /api/health"
else
  echo "WARNING: could not confirm from /api/health — check manually: curl localhost:${PORT}/api/health"
fi

echo
echo "Done. Open Sales, Purchases, the Dispatch report, Quarry dashboard and the"
echo "daily Production report to confirm real production data shows on each."
