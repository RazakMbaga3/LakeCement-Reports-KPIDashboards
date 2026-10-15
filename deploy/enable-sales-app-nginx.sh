#!/usr/bin/env bash
# Open /sales-app/ (the Integration Package's Sales Dashboard) through nginx,
# behind the dashboard's login gate. Modelled on deploy/harden-webroot.sh:
# backs up every file it touches, tests, reloads, verifies, and rolls back on
# any failure.
#
# Prerequisites: deploy/harden-webroot.sh has run (the allowlist snippet is
# included), and deploy/setup-sales-app.sh has started pm2 `sales-app`.
#
# Run on the droplet:
#   sudo bash /home/deploy/lake-cement-dashboard/deploy/enable-sales-app-nginx.sh
#
# Safe to run again (it also refreshes the snippet after a change to
# deploy/nginx-sales-app.conf). Changes nothing outside nginx's site/snippet files.
set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
DOMAIN="smr.lakecement.co.tz"
SNIPPET_SRC="$APP_DIR/deploy/nginx-sales-app.conf"
SNIPPET_DST="/etc/nginx/snippets/lcl-sales-app.conf"
ALLOW_LINE="include snippets/lcl-public-allowlist.conf;"
INCLUDE_LINE="include snippets/lcl-sales-app.conf;"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/etc/nginx/lcl-backup-$STAMP"

say()  { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -f "$SNIPPET_SRC" ] || fail "$SNIPPET_SRC not found — is the checkout up to date?"
command -v nginx >/dev/null || fail "nginx not found"
nginx -V 2>&1 | grep -q -- '--with-http_auth_request_module' \
  || fail "this nginx lacks the auth_request module the login gate needs (install nginx-full / nginx-extras)"
[ "$(curl -s -m 3 http://127.0.0.1:8501/sales-app/_stcore/health)" = "ok" ] \
  || fail "the Sales Dashboard app is not running — run deploy/setup-sales-app.sh first (as deploy)"

# ── 1. Which enabled sites serve the checkout, and do they have the allowlist?
say "Finding nginx sites that serve $APP_DIR"
SITES=()
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -e "$f" ] || continue
  real="$(readlink -f "$f")"
  if grep -qE "^\s*root\s+$APP_DIR/?;" "$real"; then SITES+=("$real"); fi
done
[ "${#SITES[@]}" -gt 0 ] || fail "no enabled nginx site has 'root $APP_DIR;'"
for f in "${SITES[@]}"; do
  grep -qF "$ALLOW_LINE" "$f" || fail "$f does not include the allowlist yet — run deploy/harden-webroot.sh first"
  echo "   $f"
done

mkdir -p "$BACKUP_DIR"
for f in "${SITES[@]}"; do cp -a "$f" "$BACKUP_DIR/"; done
[ -f "$SNIPPET_DST" ] && cp -a "$SNIPPET_DST" "$BACKUP_DIR/"
echo "   backups in $BACKUP_DIR"

rollback() {
  say "ROLLING BACK nginx changes"
  for f in "${SITES[@]}"; do cp -a "$BACKUP_DIR/$(basename "$f")" "$f"; done
  if [ -f "$BACKUP_DIR/$(basename "$SNIPPET_DST")" ]; then
    cp -a "$BACKUP_DIR/$(basename "$SNIPPET_DST")" "$SNIPPET_DST"
  else
    rm -f "$SNIPPET_DST"
  fi
  nginx -t && systemctl reload nginx
}

# ── 2. Install the snippet; include it right after the allowlist ────────────
say "Installing /sales-app/"
install -m 0644 "$SNIPPET_SRC" "$SNIPPET_DST"
for f in "${SITES[@]}"; do
  if grep -qF "$INCLUDE_LINE" "$f"; then
    echo "   already included in $f"
  else
    # after every allowlist include (HTTP and certbot's HTTPS block alike)
    sed -i -E "s#^(\s*)$ALLOW_LINE#&\n\1$INCLUDE_LINE#" "$f"
    echo "   included in $f ($(grep -cF "$INCLUDE_LINE" "$f") server block(s))"
  fi
done

if ! nginx -t; then rollback; fail "nginx -t rejected the change — rolled back, site unchanged"; fi
systemctl reload nginx
sleep 1

# ── 3. Verify through nginx ─────────────────────────────────────────────────
req() { curl -s -o /dev/null -k -m 10 -w "$1" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$2"; }

say "Pages that must still be served (expect 200)"
broken=0
for p in /login.html /index.html /sales.html /integration-package.html /auth.js /api/health; do
  c="$(req '%{http_code}' "$p")"; printf '   %-40s %s\n' "$p" "$c"
  [ "$c" = "200" ] || broken=1
done
if [ "$broken" -ne 0 ]; then rollback; fail "the site stopped serving its own pages — rolled back"; fi

say "The gate (expect 302 to the dashboard tab without a session)"
c="$(req '%{http_code} %{redirect_url}' /sales-app/)"; echo "   /sales-app/  $c"
case "$c" in 302*integration-package.html*) ;; *) rollback; fail "/sales-app/ is not behind the login gate — rolled back";; esac

say "Paths that must stay refused (expect 404)"
leaks=0
for p in /integration/sales-dashboard/.env /integration/sales-dashboard/users.toml \
         /integration/sales-dashboard/app.py /__lcl_sales_app_gate /backend/.env /.git/config; do
  c="$(req '%{http_code}' "$p")"; printf '   %-40s %s\n' "$p" "$c"
  [ "$c" = "404" ] || leaks=1
done
if [ "$leaks" -ne 0 ]; then rollback; fail "a private path became reachable — rolled back"; fi

say "Done. /sales-app/ is open to signed-in Sales, Management and MD users via the Integration Package tab."
