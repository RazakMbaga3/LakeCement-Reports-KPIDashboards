#!/usr/bin/env bash
# Remote deploy script — run on the droplet by .github/workflows/deploy.yml
# (or by hand, as the `deploy` user, for a manual/rollback deploy).
# See docs/DEPLOYMENT_DIGITALOCEAN.md §3.
set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
cd "$APP_DIR"

git fetch origin main
git reset --hard origin/main

cd backend
npm ci --omit=dev
npm run migrate

pm2 reload "$APP_DIR/deploy/ecosystem.config.js" --update-env
