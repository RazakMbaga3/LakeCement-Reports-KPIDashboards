#!/usr/bin/env bash
# Remote deploy script — run on the droplet by .github/workflows/deploy.yml
# (or by hand, as the `deploy` user, for a manual/rollback deploy).
# See docs/DEPLOYMENT_DIGITALOCEAN.md §3.
set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
cd "$APP_DIR"

if [ -z "${LCL_DEPLOY_REEXEC:-}" ]; then
  git fetch origin main
  git reset --hard origin/main
  # bash keeps executing the copy of this file it opened, so without this a
  # change to deploy.sh only took effect one deploy late (seen 2026-10-12).
  # Run the freshly checked-out copy for every step after the reset.
  LCL_DEPLOY_REEXEC=1 exec bash "$APP_DIR/deploy/deploy.sh"
fi

# ── Web-root lockdown ───────────────────────────────────────────────────────
# The checkout is nginx's web root. deploy/nginx-public-allowlist.conf is the
# real guard, but it needs sudo to install (deploy/harden-webroot.sh), so file
# permissions are the guard this unprivileged script can keep in force. nginx
# reaches the checkout through the group here: removing only other-user
# access left .git/ and backend/ served (measured 2026-10-12). So everything
# at the top level that is not part of the frontend loses group and other
# access. The deploy user (git, npm, pm2, backups) keeps full access.
chmod 600 backend/.env 2>/dev/null || true
shopt -s dotglob nullglob
for entry in *; do
  case "$entry" in forms|vendor) continue ;; esac
  if [ -f "$entry" ]; then
    case "$entry" in
      *.html|*.js|*.css|*.png|*.jpg|*.jpeg|*.gif|*.svg|*.ico|*.webp|*.woff|*.woff2) continue ;;
    esac
  fi
  chmod go-rwx -- "$entry"
done
shopt -u dotglob nullglob

cd backend
npm ci --omit=dev
npm run migrate

pm2 reload "$APP_DIR/deploy/ecosystem.config.js" --update-env

# Integration Package Sales Dashboard (Streamlit): only once
# deploy/setup-sales-app.sh has installed it, and never able to fail the main
# deploy — the dashboard above is already live by this point.
if pm2 describe sales-app >/dev/null 2>&1; then
  pm2 reload "$APP_DIR/deploy/sales-app.ecosystem.config.js" \
    || echo "WARN: sales-app reload failed — the main dashboard is unaffected; check: pm2 logs sales-app"
fi
