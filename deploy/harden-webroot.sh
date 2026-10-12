#!/usr/bin/env bash
# Stop nginx serving anything from the checkout except the frontend.
#
# On 2026-10-12 production served backend/.env, the whole .git directory and
# backend/data/mis/employees.json to anyone who asked, because nginx's web
# root IS the git checkout and nothing denied the rest of it. This script:
#   1. installs deploy/nginx-public-allowlist.conf as an nginx snippet and
#      includes it after the checkout's `root` line in every enabled site;
#   2. tests the config and reloads nginx, rolling back automatically if the
#      test fails or the site stops serving its own pages afterwards;
#   3. checks that the sensitive paths now return 404;
#   4. tightens file permissions so the same mistake can't expose .env again;
#   5. searches the nginx access logs for anyone who downloaded them before.
#
# Run on the droplet, with both files side by side:
#   scp deploy/harden-webroot.sh deploy/nginx-public-allowlist.conf deploy@138.68.166.86:/tmp/
#   ssh deploy@138.68.166.86 'sudo bash /tmp/harden-webroot.sh'
#
# Safe to run more than once. Changes nothing outside nginx's site/snippet
# files and the permissions of backend/.env and .git.
set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
DOMAIN="smr.lakecement.co.tz"
SNIPPET_SRC="$(cd "$(dirname "$0")" && pwd)/nginx-public-allowlist.conf"
SNIPPET_DST="/etc/nginx/snippets/lcl-public-allowlist.conf"
INCLUDE_LINE="include snippets/lcl-public-allowlist.conf;"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/etc/nginx/lcl-backup-$STAMP"   # outside sites-enabled, so nginx never loads it

say()  { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run with sudo"
[ -f "$SNIPPET_SRC" ] || fail "nginx-public-allowlist.conf must sit next to this script ($SNIPPET_SRC)"
command -v nginx >/dev/null || fail "nginx not found"

# ── 1. Which enabled site files serve the checkout? ─────────────────────────
say "Finding nginx sites that serve $APP_DIR"
SITES=()
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -e "$f" ] || continue
  real="$(readlink -f "$f")"
  if grep -qE "^\s*root\s+$APP_DIR/?;" "$real"; then SITES+=("$real"); fi
done
[ "${#SITES[@]}" -gt 0 ] || fail "no enabled nginx site has 'root $APP_DIR;'"
printf '   %s\n' "${SITES[@]}"

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

# ── 2. Install the snippet and include it ───────────────────────────────────
say "Installing the allowlist"
mkdir -p "$(dirname "$SNIPPET_DST")"
install -m 0644 "$SNIPPET_SRC" "$SNIPPET_DST"
for f in "${SITES[@]}"; do
  if grep -qF "$INCLUDE_LINE" "$f"; then
    echo "   already included in $f"
  else
    # straight after every `root <checkout>;` line (HTTP and certbot's HTTPS
    # block alike), so the deny rules come before any other regex location
    sed -i -E "s#^(\s*)root\s+$APP_DIR/?;#&\n\1$INCLUDE_LINE#" "$f"
    echo "   included in $f ($(grep -cF "$INCLUDE_LINE" "$f") server block(s))"
  fi
done

if ! nginx -t; then rollback; fail "nginx -t rejected the change — rolled back, site unchanged"; fi
systemctl reload nginx
sleep 1

# ── 3. Verify against the live server (through local nginx) ─────────────────
code() { curl -s -o /dev/null -k -m 10 -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN$1"; }

say "Pages that must still be served (expect 200)"
broken=0
for p in /login.html /index.html /auth.js /styles.css /forms/api-client.js \
         /vendor/xlsx-0.18.5/xlsx.full.min.js /api/health; do
  c="$(code "$p")"; printf '   %-45s %s\n' "$p" "$c"
  [ "$c" = "200" ] || broken=1
done
if [ "$broken" -ne 0 ]; then rollback; fail "the site stopped serving its own pages — rolled back"; fi

say "Paths that must now be refused (expect 404)"
leaks=0
for p in /backend/.env /.git/config /.git/HEAD /.gitignore /backend/data/mis/employees.json \
         /backend/server.js /README.md /LCL_Access_Matrix_2026.xlsx /docs/pm/RAID_LOG.md \
         /deploy/deploy.sh /e2e/fixtures/roles.js; do
  c="$(code "$p")"; printf '   %-45s %s\n' "$p" "$c"
  [ "$c" = "404" ] || leaks=1
done

# ── 4. Permissions: defence in depth if the nginx rule is ever lost ─────────
say "Tightening permissions"
ENV_FILE="$APP_DIR/backend/.env"
if [ -f "$ENV_FILE" ]; then
  chmod 600 "$ENV_FILE"; echo "   $(stat -c '%a %U:%G' "$ENV_FILE")  backend/.env"
fi
for d in .git backend; do   # nginx needs neither; deploy.sh re-applies this on every deploy
  if [ -d "$APP_DIR/$d" ]; then
    chmod o-rwx "$APP_DIR/$d"; echo "   $(stat -c '%a %U:%G' "$APP_DIR/$d")  $d/"
  fi
done
origin="$(sudo -u deploy git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
if printf '%s' "$origin" | grep -qE '://[^/@]+@'; then
  echo "   WARNING: the git remote URL contains credentials — they were readable via /.git/config."
  echo "            Revoke that token on GitHub and switch the remote to a deploy key."
fi

# ── 5. Was any of it downloaded before today? ───────────────────────────────
say "Access-log search: successful GETs of non-public paths"
PAT='"GET /(\.git/|\.env|backend/|data/|docs/|deploy/|e2e/|scripts/|node_modules/|[^" ]*\.(xlsx|xls|pdf|md|sql|dump|py|bat|env))[^" ]* HTTP/[0-9.]+" 200 '
hits="$(zgrep -hE "$PAT" /var/log/nginx/access.log* 2>/dev/null || true)"
if [ -z "$hits" ]; then
  echo "   none found in the logs still on disk ($(ls /var/log/nginx/access.log* 2>/dev/null | wc -l) files;"
  echo "   oldest: $(ls -tr /var/log/nginx/access.log* 2>/dev/null | head -1)). Older logs may have been rotated away."
else
  echo "   $(printf '%s\n' "$hits" | wc -l) request(s). By client IP:"
  printf '%s\n' "$hits" | awk '{print $1}' | sort | uniq -c | sort -rn | head -20 | sed 's/^/     /'
  echo "   Any hit on backend/.env or .git/ means the secrets must be treated as stolen:"
  printf '%s\n' "$hits" | grep -E '"GET /(backend/\.env|\.env|\.git/)' | head -20 | sed 's/^/     /' || true
fi

if [ "$leaks" -ne 0 ]; then fail "some sensitive paths are still reachable — see the table above"; fi
say "Done. nginx now serves only the frontend. NEXT: rotate the secrets (deploy/rotate-local-secrets.sh)."
