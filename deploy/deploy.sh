#!/usr/bin/env bash
# Remote deploy script — run on the droplet by .github/workflows/deploy.yml
# (or by hand, as the `deploy` user, for a manual/rollback deploy).
# See docs/DEPLOYMENT_DIGITALOCEAN.md §3.
set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
cd "$APP_DIR"

git fetch origin main
git reset --hard origin/main

# The checkout is nginx's web root. nginx (www-data) needs only the frontend,
# so keep secrets and server code unreadable to it even if the allowlist in
# deploy/nginx-public-allowlist.conf is ever lost (2026-10-12: .env was
# publicly downloadable). Everything here runs as `deploy`, which keeps access.
chmod 600 backend/.env 2>/dev/null || true
chmod o-rwx .git backend

cd backend
npm ci --omit=dev
npm run migrate

pm2 reload "$APP_DIR/deploy/ecosystem.config.js" --update-env
