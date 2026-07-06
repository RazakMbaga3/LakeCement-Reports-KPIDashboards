/*
  services/health.js — deep health check behind GET /api/health.

  status: 'ok'        — everything green
          'degraded'  — running, but something needs attention (disk low,
                        backup stale)
          'down'      — the database is unreachable; the app cannot work

  Odoo sync age joins these checks when Phase 4 lands; until then it
  reports 'not_configured'. Backup freshness activates once BACKUP_DIR is
  set (Phase 7).
*/

const fsp  = require('fs/promises');
const path = require('path');
const db   = require('../db');

const DISK_MIN_FREE_GB = parseFloat(process.env.DISK_MIN_FREE_GB || '5');
const BACKUP_MAX_AGE_H = parseFloat(process.env.BACKUP_MAX_AGE_HOURS || '26');

async function checkDb() {
  const t0 = Date.now();
  try {
    await db.query('SELECT 1');
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkDisk() {
  try {
    const root = path.parse(process.cwd()).root; // the drive this app runs on
    const s = await fsp.statfs(root);
    const freeGb = (s.bavail * s.bsize) / 1e9;
    return { ok: freeGb >= DISK_MIN_FREE_GB, free_gb: Math.round(freeGb * 10) / 10, drive: root, min_gb: DISK_MIN_FREE_GB };
  } catch (err) {
    return { ok: true, note: 'disk check unavailable: ' + err.message };
  }
}

async function checkBackup() {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return 'not_configured';
  try {
    const files = await fsp.readdir(dir);
    let newest = 0;
    for (const f of files) {
      if (!/\.(dump|sql|backup|gz)$/i.test(f)) continue;
      const st = await fsp.stat(path.join(dir, f));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
    if (!newest) return { ok: false, error: 'no backup files in ' + dir };
    const ageH = (Date.now() - newest) / 3600000;
    return { ok: ageH <= BACKUP_MAX_AGE_H, age_hours: Math.round(ageH * 10) / 10, max_hours: BACKUP_MAX_AGE_H };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deepHealth() {
  const [dbCheck, disk, backup] = await Promise.all([checkDb(), checkDisk(), checkBackup()]);

  let status = 'ok';
  if (!disk.ok || (backup !== 'not_configured' && !backup.ok)) status = 'degraded';
  if (!dbCheck.ok) status = 'down';

  return {
    status,
    app: 'Lake Cement MIS Backend',
    version: '1.0.0',
    uptime_s: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: { db: dbCheck, disk, backup, odoo: 'not_configured' },
  };
}

module.exports = { deepHealth };
