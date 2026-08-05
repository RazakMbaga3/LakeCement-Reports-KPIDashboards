/*
  services/health.js — deep health check behind GET /api/health.

  status: 'ok'        — everything green
          'degraded'  — running, but something needs attention (disk low,
                        backup stale)
          'down'      — the database is unreachable; the app cannot work

  Odoo check is config-presence only (see checkOdoo below) — reports
  'not_configured' until ODOO_URL is set; real connectivity is checked
  separately by GET /api/monitor/odoo/test so a flaky Odoo link can't turn
  every health poll 'degraded'. Backup freshness activates once BACKUP_DIR
  is set (Phase 7).
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

function checkOdoo() {
  // Config presence only — a live RPC call here would make every health
  // poll depend on Odoo's own network/uptime. Use GET /api/monitor/odoo/test
  // (or `npm run odoo:test`) to verify real connectivity to the generic
  // Odoo API specifically. Two independent connections can each report
  // configured — see services/odooSync.js for why they're separate.
  const generic  = !!process.env.ODOO_URL;
  const dispatch = !!process.env.ODOO_DISPATCH_URL;
  if (!generic && !dispatch) return 'not_configured';
  return {
    ok: true,
    generic:  generic  ? 'configured, no pulls wired up yet' : 'not_configured',
    dispatch: dispatch ? 'configured, pulling on schedule'   : 'not_configured',
  };
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
    checks: { db: dbCheck, disk, backup, odoo: checkOdoo() },
  };
}

module.exports = { deepHealth };
