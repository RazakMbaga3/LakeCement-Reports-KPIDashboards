#!/usr/bin/env bash
# deploy/configure-backups.sh
#
# One-shot script for whoever runs commands on the production droplet.
# Points nightly pg_dump backups (backend/services/backup.js) at a real
# backup location, then proves it works end-to-end: writes a dump,
# restores it into a scratch database, and confirms /api/health reports
# backups as healthy.
#
# Why this exists: BACKUP_DIR was never set on this droplet (RAID I-7),
# so nightly backups have not been running at all. A backup dir on the
# SAME disk as the app/database is not a real backup either — one disk
# failure loses both — so this script refuses to proceed onto a same-disk
# path rather than silently accepting it.
#
# What it does, in order:
#   1. Picks the backup path: $1 if you pass one, else the default below.
#   2. Creates it if missing, and checks it is NOT the same physical disk
#      as the app directory — aborts with a clear error if it is (that
#      means no second volume/share is actually attached yet).
#   3. Sets BACKUP_DIR in backend/.env (backing up the old .env first).
#   4. Reloads the app (pm2) so the new .env takes effect.
#   5. Runs one real backup (`npm run backup`).
#   6. Runs one restore drill (`npm run restore:drill`) — proves the
#      dump is actually restorable, not just written.
#   7. Prints /api/health — `backup` should read "ok", not
#      "not_configured".
#
# Usage (run as the `deploy` user, on the droplet):
#
#   bash configure-backups.sh                       # uses the default path below
#   bash configure-backups.sh /mnt/volume_xyz/backups  # uses a specific mounted volume
#
# Default path assumes a DigitalOcean Volume mounted at /mnt/<volume-name>
# per DO's standard convention — if you've attached one, point this at it
# (e.g. /mnt/lcl-backups/db). If no volume is attached yet, attach one
# first (DO control panel → Volumes → Create → attach to this droplet),
# then re-run this script with its mount path.
#
# Safe to re-run.

set -euo pipefail

APP_DIR="/home/deploy/lake-cement-dashboard"
ENV_FILE="$APP_DIR/backend/.env"
DEFAULT_BACKUP_DIR="/mnt/lcl-backups/db"
BACKUP_DIR_PATH="${1:-$DEFAULT_BACKUP_DIR}"

echo "== 1/7  Preparing backup directory: $BACKUP_DIR_PATH =="
mkdir -p "$BACKUP_DIR_PATH"

echo
echo "== 2/7  Checking it is on a separate disk from the app =="
APP_DEVICE="$(df --output=source "$APP_DIR" | tail -1)"
BACKUP_DEVICE="$(df --output=source "$BACKUP_DIR_PATH" | tail -1)"
if [ "$APP_DEVICE" = "$BACKUP_DEVICE" ]; then
  echo "ERROR: $BACKUP_DIR_PATH is on the SAME disk ($APP_DEVICE) as $APP_DIR." >&2
  echo "That is not a real backup — one disk failure loses both the database and its backups." >&2
  echo "Attach a DigitalOcean Volume (or point this at a network share) and re-run:" >&2
  echo "  bash $0 /path/to/separate/volume" >&2
  exit 1
fi
echo "  OK — app is on $APP_DEVICE, backups on $BACKUP_DEVICE"

echo
echo "== 3/7  Setting BACKUP_DIR in backend/.env =="
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found — is APP_DIR correct? Aborting." >&2
  exit 1
fi

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
echo "  (backed up existing .env)"

if grep -qE "^BACKUP_DIR=" "$ENV_FILE"; then
  sed -i "s|^BACKUP_DIR=.*|BACKUP_DIR=${BACKUP_DIR_PATH}|" "$ENV_FILE"
  echo "  updated BACKUP_DIR"
else
  printf '\nBACKUP_DIR=%s\n' "$BACKUP_DIR_PATH" >> "$ENV_FILE"
  echo "  added BACKUP_DIR (was missing)"
fi

echo
echo "== 4/7  Reloading the app so the new .env takes effect =="
pm2 reload "$APP_DIR/deploy/ecosystem.config.js" --update-env
sleep 3

echo
echo "== 5/7  Running one backup now =="
cd "$APP_DIR/backend"
npm run backup

echo
echo "== 6/7  Running a restore drill (restores into a scratch DB, verifies, drops it) =="
npm run restore:drill

echo
echo "== 7/7  Health check =="
PORT="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d'=' -f2)"
PORT="${PORT:-5000}"
HEALTH="$(curl -sS "http://localhost:${PORT}/api/health" || true)"
echo "$HEALTH"
if echo "$HEALTH" | grep -q '"backup":{"ok":true'; then
  echo "OK — backups are configured, tested, and healthy."
  echo "FTP can now be pointed at: $BACKUP_DIR_PATH"
else
  echo "WARNING: could not confirm from /api/health — check manually: curl localhost:${PORT}/api/health"
fi
