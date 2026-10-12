#!/usr/bin/env bash
# Rotate the secrets in backend/.env that this server can rotate by itself,
# after .env was publicly downloadable (2026-10-12, see harden-webroot.sh).
#
#   JWT_SECRET         new random value — every user is signed out and logs in again
#   DB_PASSWORD        new random value, applied with ALTER ROLE (local Postgres only)
#   PG_ADMIN_PASSWORD  same, for the restore-drill admin role, if one is configured
#   METRICS_TOKEN      new random value, if set — update any scraper that uses it
#
# Secrets owned by OTHER systems cannot be rotated from here and are listed
# at the end: the SMTP password (Microsoft 365) and the Odoo API keys.
#
# Dry run by default (prints what it would change, never a secret value):
#   sudo bash rotate-local-secrets.sh
#   sudo bash rotate-local-secrets.sh --apply
#
# With --apply it backs .env up first, and if the app does not come back
# healthy it restores the old .env and the old DB password automatically.
set -euo pipefail
umask 077   # any temp copy of .env is root/owner-only

APP_DIR="/home/deploy/lake-cement-dashboard"
ENV_FILE="$APP_DIR/backend/.env"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1

fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found"
command -v openssl >/dev/null || fail "openssl not found"

# Read one KEY's value from .env (last assignment wins, surrounding quotes stripped).
getenv() {
  awk -v k="$1" -F= '$1==k { sub(/^[^=]*=/, ""); v=$0 } END { gsub(/^["'\'']|["'\'']$/, "", v); print v }' "$ENV_FILE"
}
# Set KEY=value in a file in place, appending it if absent. The value travels
# via the environment (no quoting traps); `cat >` keeps the file's owner/mode.
setenv_in() {
  local file="$1" key="$2"
  NEWVAL="$3" awk -v k="$key" -F= '$1==k { print k "=" ENVIRON["NEWVAL"]; done=1; next } { print }
    END { if (!done) print k "=" ENVIRON["NEWVAL"] }' "$file" > "$file.tmp"
  cat "$file.tmp" > "$file"; rm -f "$file.tmp"
}
psql_set_password() {   # role, password — through stdin so neither appears in `ps`
  printf 'ALTER ROLE :"r" PASSWORD :'"'"'p'"'"';\n' |
    sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -v r="$1" -v p="$2" >/dev/null
}
# Healthy = a freshly restarted process (uptime under 100 s, so not the old
# one, whose open DB connections survive ALTER ROLE) reaching the database.
health_ok() {
  local j
  for _ in $(seq 1 30); do
    j="$(curl -s -m 5 http://127.0.0.1:5000/api/health || true)"
    if printf '%s' "$j" | grep -qE '"uptime_s":[0-9]{1,2},' &&
       printf '%s' "$j" | grep -q '"db":{[^}]*"ok":true'; then return 0; fi
    sleep 2
  done
  return 1
}
reload_app() {
  sudo -u deploy -H bash -lc "pm2 reload '$APP_DIR/deploy/ecosystem.config.js' --update-env" >/dev/null
}

DB_HOST="$(getenv DB_HOST)"; DB_USER="$(getenv DB_USER)"; DB_PASSWORD_OLD="$(getenv DB_PASSWORD)"
PG_ADMIN_USER="$(getenv PG_ADMIN_USER)"; PG_ADMIN_PASSWORD_OLD="$(getenv PG_ADMIN_PASSWORD)"
METRICS_OLD="$(getenv METRICS_TOKEN)"
LOCAL_DB=0; case "${DB_HOST:-localhost}" in localhost|127.0.0.1|::1) LOCAL_DB=1 ;; esac

echo "Plan (values are never printed):"
echo "  JWT_SECRET          rotate"
if [ "$LOCAL_DB" -eq 1 ] && [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD_OLD" ]; then
  echo "  DB_PASSWORD         rotate (ALTER ROLE \"$DB_USER\")"
else
  echo "  DB_PASSWORD         SKIP — DB_HOST=$DB_HOST is not local; rotate it at the database provider"
fi
if [ "$LOCAL_DB" -eq 1 ] && [ -n "$PG_ADMIN_USER" ] && [ -n "$PG_ADMIN_PASSWORD_OLD" ]; then
  echo "  PG_ADMIN_PASSWORD   rotate (ALTER ROLE \"$PG_ADMIN_USER\")"
else
  echo "  PG_ADMIN_PASSWORD   skip (not configured)"
fi
if [ -n "$METRICS_OLD" ]; then echo "  METRICS_TOKEN       rotate"; else echo "  METRICS_TOKEN       skip (not set)"; fi

if [ "$APPLY" -ne 1 ]; then
  echo; echo "Dry run only. Re-run with --apply to make these changes."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/lcl-env-backup-$STAMP"
install -m 600 -o root -g root "$ENV_FILE" "$BACKUP"
echo; echo "Backed up .env to $BACKUP (root-only). Delete it once everything is confirmed working."

NEW_JWT="$(openssl rand -hex 48)"
NEW_DB="$(openssl rand -hex 24)"
NEW_ADMIN="$(openssl rand -hex 24)"
NEW_METRICS="$(openssl rand -hex 24)"

restore() {
  echo "Restoring the previous .env and database password(s)…"
  [ "$DB_ROTATED" -eq 1 ] && psql_set_password "$DB_USER" "$DB_PASSWORD_OLD"
  [ "$ADMIN_ROTATED" -eq 1 ] && psql_set_password "$PG_ADMIN_USER" "$PG_ADMIN_PASSWORD_OLD"
  cat "$BACKUP" > "$ENV_FILE"
  reload_app
}
DB_ROTATED=0; ADMIN_ROTATED=0

if [ "$LOCAL_DB" -eq 1 ] && [ -n "$DB_USER" ] && [ -n "$DB_PASSWORD_OLD" ]; then
  psql_set_password "$DB_USER" "$NEW_DB"; DB_ROTATED=1
  setenv_in "$ENV_FILE" DB_PASSWORD "$NEW_DB"
fi
if [ "$LOCAL_DB" -eq 1 ] && [ -n "$PG_ADMIN_USER" ] && [ -n "$PG_ADMIN_PASSWORD_OLD" ]; then
  psql_set_password "$PG_ADMIN_USER" "$NEW_ADMIN"; ADMIN_ROTATED=1
  setenv_in "$ENV_FILE" PG_ADMIN_PASSWORD "$NEW_ADMIN"
fi
setenv_in "$ENV_FILE" JWT_SECRET "$NEW_JWT"
[ -n "$METRICS_OLD" ] && setenv_in "$ENV_FILE" METRICS_TOKEN "$NEW_METRICS"
chown deploy:deploy "$ENV_FILE"; chmod 600 "$ENV_FILE"

echo "Reloading the app…"
reload_app
if ! health_ok; then
  restore
  fail "the app did not report a healthy database within 60 s — previous secrets restored"
fi
echo "App healthy on the new secrets. Everyone has been signed out and must log in again."

cat <<'EOF'

STILL TO DO — these secrets belong to other systems and were also in the exposed file:
  1. SMTP_PASS     Ask the Microsoft 365 admin to reset the password of digital@lakecement.co.tz
                   (or issue a new app password), then put it in backend/.env.
  2. ODOO_*_API_KEY and ODOO_API_KEY
                   Ask the Odoo administrator to revoke and regenerate every API key used here
                   (Odoo: user Preferences → Account Security → API Keys), then update backend/.env.
  3. After editing .env:   sudo -u deploy -H bash -lc "pm2 reload /home/deploy/lake-cement-dashboard/deploy/ecosystem.config.js --update-env"
  4. If harden-webroot.sh warned that the git remote URL holds a token, revoke it on GitHub.
EOF
