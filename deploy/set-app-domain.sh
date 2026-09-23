#!/usr/bin/env bash
# Sets ALLOWED_ORIGIN and APP_URL in backend/.env to https://<domain>,
# adding either line if it's missing. Idempotent — safe to re-run.
# Used for the initial go-live domain and for any later domain swap
# (see docs/DEPLOYMENT_DIGITALOCEAN.md §2.7).
#
# Usage (from the repo root, on the droplet):
#   bash deploy/set-app-domain.sh smr.lakecement.co.tz
#   pm2 reload ecosystem.config.js

set -euo pipefail

DOMAIN="${1:?Usage: set-app-domain.sh <domain>  (e.g. smr.lakecement.co.tz)}"
ENV_FILE="$(dirname "$0")/../backend/.env"
URL="https://${DOMAIN}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE found — copy backend/.env.example to backend/.env first." >&2
  exit 1
fi

set_kv() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_kv ALLOWED_ORIGIN "$URL"
set_kv APP_URL "$URL"

echo "Updated $ENV_FILE:"
grep -E '^(ALLOWED_ORIGIN|APP_URL)=' "$ENV_FILE"
echo "Now run: pm2 reload ecosystem.config.js"
