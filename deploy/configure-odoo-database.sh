#!/usr/bin/env bash
# deploy/configure-odoo-database.sh
#
# One-shot script for whoever runs commands on the production droplet.
# Connects the live server to Odoo's own database (read-only) and loads the
# reports that read it: Captive Power Plant days, overburden, crusher apron
# hours / TPH, and the Production report's stock ledgers.
#
#   ssh deploy@138.68.166.86
#   cd /home/deploy/lake-cement-dashboard && git pull
#   bash deploy/configure-odoo-database.sh
#
# It asks for the Odoo database password (typed, never echoed, never stored
# anywhere except the server's own backend/.env, which only the deploy user
# can read). Nothing is hardcoded here.
#
# What it does, in order — and it STOPS at the first thing that looks wrong:
#   1. Deploys the latest code the same way the automatic deploy does
#      (deploy/deploy.sh: pull, install, migrate, reload). Use this instead
#      of waiting for the automatic deploy when that is red.
#   2. Checks this server can reach the Odoo database port at all.
#   3. Writes the ODOO_PG_* settings into backend/.env (backing it up first).
#      The connection accepts ONLY the Odoo server's own certificate
#      (backend/config/odoo-db-server.pem), so someone sitting between this
#      server and Odoo cannot impersonate it.
#   4. Reloads the app and runs the connection test.
#   5. Shows what each load WOULD change (dry run), asks you to confirm, then
#      loads it. Every load only ever fills blanks or adds new days: nothing
#      anybody typed is overwritten.
#   6. Prints the health check.
#
# Safe to re-run: every step is idempotent.

set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
ENV_FILE="$APP_DIR/backend/.env"
PG_HOST="${ODOO_PG_HOST:-134.209.17.225}"
PG_PORT="${ODOO_PG_PORT:-5432}"
PG_DB="${ODOO_PG_DATABASE:-parallel}"
PG_USER="${ODOO_PG_USER:-mitesh_reporting}"
TODAY="$(date +%F)"

cd "$APP_DIR"

echo "== 1/6  Deploying the latest code (pull, install, migrate, reload) =="
bash "$APP_DIR/deploy/deploy.sh"

echo
echo "== 2/6  Can this server reach the Odoo database? =="
if timeout 10 bash -c "</dev/tcp/${PG_HOST}/${PG_PORT}" 2>/dev/null; then
  echo "  yes — ${PG_HOST}:${PG_PORT} answers"
else
  echo "ERROR: ${PG_HOST}:${PG_PORT} does not answer from this server." >&2
  echo "       Ask the Odoo administrator to allow this server's address on the database port, then run this again." >&2
  echo "       This server's public address: $(curl -sS --max-time 5 https://ifconfig.me || echo '(look it up with: curl ifconfig.me)')" >&2
  exit 1
fi

echo
echo "== 3/6  Writing the Odoo database settings into backend/.env =="
if [ ! -f "$ENV_FILE" ]; then echo "ERROR: $ENV_FILE not found — is APP_DIR right?" >&2; exit 1; fi
if [ -z "${ODOO_PG_PASSWORD:-}" ]; then
  read -rsp "  Odoo database password for ${PG_USER} (typing is hidden): " ODOO_PG_PASSWORD; echo
fi
[ -n "$ODOO_PG_PASSWORD" ] || { echo "ERROR: no password given." >&2; exit 1; }
cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
chmod 600 "$ENV_FILE"

set_env_var() {
  local key="$1" value="$2"
  # '|' is the sed delimiter, so escape it (and & and \) in the value.
  local esc; esc="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE"; echo "  updated $key"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"; echo "  added $key"
  fi
}
set_env_var ODOO_PG_HOST     "$PG_HOST"
set_env_var ODOO_PG_PORT     "$PG_PORT"
set_env_var ODOO_PG_DATABASE "$PG_DB"
set_env_var ODOO_PG_USER     "$PG_USER"
set_env_var ODOO_PG_PASSWORD "$ODOO_PG_PASSWORD"
set_env_var ODOO_PG_SSLMODE  "pinned"
unset ODOO_PG_PASSWORD

echo
echo "== 4/6  Reloading the app and testing the connection =="
pm2 reload "$APP_DIR/deploy/ecosystem.config.js" --update-env
sleep 3
cd "$APP_DIR/backend"
npm run odoo:db-test
echo "  (the line above must say: read-only: on, TLS: true)"

echo
echo "== 5/6  Loading the data =="
confirm() {
  read -rp "  Looks right? Type yes to load it for real: " ans
  [ "$ans" = "yes" ] || { echo "  Stopped. Nothing was loaded for this step."; exit 1; }
}

echo "-- a) Overburden (every Waste Material Entry since 2023) --"
npm run odoo:waste-backfill

echo "-- b) Power plant days 21 Sep .. today: what would change --"
npm run odoo:cpp-sync -- 2026-09-21 "$TODAY" --dry-run
confirm
npm run odoo:cpp-sync -- 2026-09-21 "$TODAY"

echo "-- c) Crusher apron-feeder hours (fills blanks only) --"
node scripts/odoo-crusher-apron-backfill.js 2026-04-01 "$TODAY" --dry-run
confirm
node scripts/odoo-crusher-apron-backfill.js 2026-04-01 "$TODAY"

echo "-- d) Production report stock ledgers, rolled from the plant's 30 June closing --"
npm run odoo:stock-ledger -- --dry-run
confirm
npm run odoo:stock-ledger

echo
echo "== 6/6  Health check =="
PORT="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d'=' -f2)"; PORT="${PORT:-5000}"
curl -sS "http://localhost:${PORT}/api/health" || true
echo
echo "Done. The pulls cpp-autofill, waste-material-entries and production-stock-ledger now run every 30 minutes."
echo "Open https://smr.lakecement.co.tz/production.html and pick a recent date to see the new figures."
