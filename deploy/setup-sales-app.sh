#!/usr/bin/env bash
# One-time setup of the Integration Package on the droplet: the Python
# environment, the Sales Dashboard app (Streamlit, pm2 `sales-app`), and the
# live-figure bridge used by the Integration Package tab.
#
# Run as the `deploy` user (NOT root), from the checkout:
#   bash /home/deploy/lake-cement-dashboard/deploy/setup-sales-app.sh
# Then, once, with sudo:  deploy/enable-sales-app-nginx.sh (opens /sales-app/).
#
# BEFORE running, put two files in integration/sales-dashboard/ (never in git):
#   .env        — copy .env.example and fill in PG_PASSWORD; also set
#                 REFRESH_SECONDS=3600 and PG_SSLMODE=require (checked below)
#   users.toml  — the Sales Dashboard logins; copy the collaborator's file
#                 (it holds password hashes, not passwords)
#
# This server NEVER sends the package's e-mails and creates NO scheduled jobs:
# those stay on the collaborator's Windows PC (see PROVENANCE.json).
#
# Safe to run again; it checks before it changes, in this order: files,
# memory/disk, Odoo reachability, Python env, file integrity, encrypted
# read-only login, then (re)starts the app.
set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
DIR="$APP_DIR/integration/sales-dashboard"
UV_VERSION="0.13.1"          # tested with this version on 2026-10-15
MIN_AVAIL_MB="${MIN_AVAIL_MB:-700}"

say()  { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }
val()  { grep -E "^[[:space:]]*$1=" "$DIR/.env" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

[ "$(id -u)" -ne 0 ] || fail "run as the deploy user, not root (pm2 and the files belong to deploy)"
[ -f "$DIR/app.py" ] || fail "$DIR/app.py not found — is the checkout up to date?"

# ── 1. The two private files ────────────────────────────────────────────────
say "Private files"
[ -f "$DIR/.env" ] || fail "missing $DIR/.env — copy .env.example to .env and fill in PG_PASSWORD"
[ -f "$DIR/users.toml" ] || fail "missing $DIR/users.toml — copy the collaborator's users.toml here"
chmod 600 "$DIR/.env" "$DIR/users.toml"
for k in PG_HOST PG_PORT PG_DB PG_USER PG_PASSWORD; do
  [ -n "$(val "$k")" ] || fail "$k is empty in .env"
done
rs="$(val REFRESH_SECONDS)"
[ -n "$rs" ] && [ "$rs" -ge 3600 ] 2>/dev/null \
  || fail "REFRESH_SECONDS must be 3600 or more in .env (got '${rs:-unset}'); unset, the app re-reads Odoo every 60 s"
[ "$(val PG_SSLMODE)" = "require" ] || [ "$(val PG_SSLMODE)" = "verify-full" ] \
  || fail "set PG_SSLMODE=require in .env — without it the Odoo password crosses the internet unencrypted"
echo "   .env and users.toml present, private (600), settings OK"

# ── 2. Room to run ──────────────────────────────────────────────────────────
say "Memory and disk"
avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
disk="$(df -Pm "$APP_DIR" | awk 'NR==2 {print $4}')"
echo "   available memory ${avail} MB (need ${MIN_AVAIL_MB}), free disk ${disk} MB (need 1500)"
[ "$avail" -ge "$MIN_AVAIL_MB" ] || fail "not enough free memory for the Sales Dashboard (~250-400 MB, up to 600). Resize the droplet or add swap first."
[ "$disk" -ge 1500 ] || fail "not enough free disk for the Python environment (~1 GB)"

# ── 3. Can this server reach Odoo's database at all? ────────────────────────
say "Odoo database reachability"
host="$(val PG_HOST)"; port="$(val PG_PORT)"
if timeout 8 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
  echo "   $host:$port is reachable"
else
  fail "cannot reach $host:$port from this server — ask the Odoo team to allow this server's IP on PostgreSQL (pg_hba.conf / firewall)"
fi

# ── 4. Python 3.12 environment (uv: no sudo, no system Python changes) ──────
say "Python environment"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null || [ "$(uv --version | awk '{print $2}')" != "$UV_VERSION" ]; then
  curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" | env UV_NO_MODIFY_PATH=1 sh
fi
uv --version
cd "$DIR"
[ -x .venv/bin/python ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-lock.txt
.venv/bin/python --version

# Encrypt the Odoo connection without editing the collaborator's code.
site="$(.venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
install -m 0644 sitecustomize_pg_ssl.py "$site/lcl_pg_ssl.py"
printf 'import lcl_pg_ssl\n' > "$site/lcl_pg_ssl.pth"
echo "   encryption wrapper installed in $site"

# ── 5. The collaborator's files are exactly as received ─────────────────────
say "File integrity"
(cd "$APP_DIR" && sha256sum -c --quiet integration/sales-dashboard/SHA256SUMS) \
  || fail "a vendored file differs from the package copy (SHA256SUMS) — do not run modified code unknowingly"
echo "   all vendored files match SHA256SUMS"

# ── 6. Encrypted, read-only login ───────────────────────────────────────────
say "Odoo login check"
out="$(.venv/bin/python web_extract.py check 2>/dev/null)" || fail "Odoo login check failed: $out"
echo "   $out"
printf '%s' "$out" | grep -q '"encrypted": true' || fail "the Odoo connection is NOT encrypted"
printf '%s' "$out" | grep -q '"tables_writable": 0' || fail "the Odoo account can WRITE — use a read-only account"

# ── 7. Start (or restart) the app ───────────────────────────────────────────
say "Starting the Sales Dashboard (pm2: sales-app)"
cd "$APP_DIR"
if pm2 describe sales-app >/dev/null 2>&1; then
  pm2 reload deploy/sales-app.ecosystem.config.js
else
  pm2 start deploy/sales-app.ecosystem.config.js
fi
pm2 save >/dev/null
for i in $(seq 1 30); do
  if [ "$(curl -s -m 3 http://127.0.0.1:8501/sales-app/_stcore/health)" = "ok" ]; then break; fi
  sleep 2
done
[ "$(curl -s -m 3 http://127.0.0.1:8501/sales-app/_stcore/health)" = "ok" ] \
  || fail "the app did not come up — see: pm2 logs sales-app"
echo "   health: ok (127.0.0.1:8501/sales-app/)"

say "Done. NEXT (once, with sudo): sudo bash $APP_DIR/deploy/enable-sales-app-nginx.sh"
