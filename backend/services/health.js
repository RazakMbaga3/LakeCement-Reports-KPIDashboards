/*
  services/health.js — deep health check behind GET /api/health.

  status: 'ok'        — everything green
          'degraded'  — running, but something needs attention (disk low,
                        backup stale)
          'down'      — the database is unreachable; the app cannot work

  Odoo check has two parts. checkOdoo() is config-presence only — reports
  'not_configured' until ODOO_URL is set; real connectivity is checked
  separately by GET /api/monitor/odoo/test so a flaky Odoo link can't turn
  every health poll 'degraded'. checkOdooSync() (added 2026-09-24) reads
  what each scheduled pull LAST DID from odoo_sync_state — no live Odoo
  call — so a pull that has stopped running, or has been failing for hours,
  is visible here instead of hiding behind "configured". It only degrades
  health once a pull is genuinely overdue (hours, not one bad poll).
  Backup freshness activates once BACKUP_DIR is set (Phase 7).
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
  // Odoo API specifically. These connections are independent and can each
  // report configured — see services/odooSync.js for why they're separate.
  const generic  = !!process.env.ODOO_URL;
  const dispatch = !!process.env.ODOO_DISPATCH_URL;
  // Mining can derive its config from the dispatch pair (see
  // odooMiningClient.js), so asking the client itself is the only check
  // that can't disagree with what a real pull would do.
  const mining     = require('./odooMiningClient').isConfigured();
  const dashboard  = !!process.env.ODOO_DASHBOARD_URL;
  const production = require('./odooProductionClient').isConfigured();
  /* Same reasoning as mining: the stores endpoints derive their URL from
     whichever bespoke pair is set, so only the client can answer
     truthfully. All three share one host today, so one flag covers them. */
  const storesClient = require('./odooStoresClient');
  const stores = storesClient.isConfigured('gate')
    && storesClient.isConfigured('grn')
    && storesClient.isConfigured('issues');
  if (!generic && !dispatch && !mining && !dashboard && !production && !stores) return 'not_configured';
  /* "configured" only — this used to say "pulling on schedule", which was
     a claim about the cron that nothing here checked (URLs set + cron off
     read identically). Whether a pull is actually running is what
     checkOdooSync() below answers. */
  return {
    ok: true,
    generic:    generic    ? 'configured, no pulls wired up yet' : 'not_configured',
    dispatch:   dispatch   ? 'configured'                        : 'not_configured',
    mining:     mining     ? 'configured'                        : 'not_configured',
    dashboard:  dashboard  ? 'configured, read on demand'        : 'not_configured',
    production: production ? 'configured'                        : 'not_configured',
    stores:     stores     ? 'configured'                        : 'not_configured',
  };
}

/* ── Odoo pull freshness ─────────────────────────────────────────────── */

const LIVE_MAX_AGE_MIN  = parseFloat(process.env.ODOO_LIVE_SYNC_MAX_AGE_MIN || '180'); // half-hourly job: 3h = 6 missed runs
const DAILY_MAX_AGE_MIN = parseFloat(process.env.ODOO_SYNC_MAX_AGE_HOURS || '26') * 60;
const STARTING_GRACE_S  = 900; // after a boot, "never run yet" is expected for a while

/* Which schedules will actually run a pull in THIS process — mirrors the
   gating in server.js so the answer can't drift from what really fires.
   LIVE_PULLS comes from config/odooPulls.js rather than being restated here:
   when production joined the live job on 2026-09-28, a local copy of the list
   was exactly what would have gone on reporting `not_scheduled` for a pull
   that had in fact started running. (It cannot be imported from odooSync.js —
   that closes a health -> odooSync -> watchdog -> health cycle; see that
   config file.) */
const { LIVE_PULLS } = require('../config/odooPulls');

function pullSchedule(pullName) {
  const live  = !!(process.env.ODOO_DISPATCH_URL || process.env.ODOO_MINING_URL || process.env.ODOO_PRODUCTION_URL)
                && process.env.ODOO_LIVE_SYNC_CRON !== 'off';
  const daily = !!(process.env.ODOO_URL || process.env.ODOO_DISPATCH_URL)
                && process.env.ODOO_SYNC_CRON !== 'off';
  return { live: LIVE_PULLS.includes(pullName) && live, daily };
}

/* Pure: one pull's state row + how it's scheduled -> a verdict. Kept free
   of I/O so the edge cases (never run, failing, overdue, cron off) are
   unit-testable. */
function classifySync(row, { live, daily }, { now = Date.now(), uptimeS = 0 } = {}) {
  if (!live && !daily) {
    return { ok: false, status: 'not_scheduled',
             note: 'no cron is enabled for this pull (ODOO_SYNC_CRON / ODOO_LIVE_SYNC_CRON are off) — nothing fetches it automatically' };
  }
  const maxAgeMin = live ? LIVE_MAX_AGE_MIN : DAILY_MAX_AGE_MIN;
  const okAt  = row && row.last_success_at ? new Date(row.last_success_at).getTime() : null;
  const errAt = row && row.last_error_at   ? new Date(row.last_error_at).getTime()   : null;
  const base  = {
    last_success_at: okAt ? new Date(okAt).toISOString() : null,
    last_success_min_ago: okAt ? Math.round((now - okAt) / 60000) : null,
    max_age_min: Math.round(maxAgeMin),
  };

  if (errAt && (!okAt || errAt > okAt)) {
    /* No raw error text here: GET /api/health is public, and upstream error
       strings can name hosts/paths (RAID I-17 was exactly that leak). The
       full message is on the authenticated GET /api/monitor/odoo/sync. */
    return { ok: false, status: 'failing', ...base,
             last_error_at: new Date(errAt).toISOString(),
             note: 'last run failed — details on GET /api/monitor/odoo/sync (admin/md/it)' };
  }
  if (!okAt) {
    return uptimeS < STARTING_GRACE_S
      ? { ok: true, status: 'starting', ...base, note: 'first run has not finished yet' }
      : { ok: false, status: 'never_run', ...base, note: 'scheduled but has never completed a run' };
  }
  if ((now - okAt) / 60000 > maxAgeMin) {
    return { ok: false, status: 'stale', ...base };
  }
  return { ok: true, status: 'ok', ...base };
}

async function checkOdooSync() {
  const mining     = require('./odooMiningClient').isConfigured();
  const dispatch   = !!process.env.ODOO_DISPATCH_URL;
  const production = require('./odooProductionClient').isConfigured();
  /* The stores endpoints derive their URLs, so only the client can say
     whether they are usable — same rule as mining above. */
  const storesClient = require('./odooStoresClient');
  const stores = storesClient.isConfigured('gate')
    && storesClient.isConfigured('grn')
    && storesClient.isConfigured('issues');
  const sales = require('./odooDashboardClient').isConfigured();
  /* The direct read-only database login (2026-10-15) — CPP and overburden
     read Odoo's tables through it rather than through a report URL. */
  const odooDb = require('./odooDb').isConfigured();

  /* This list is the one place a pull can be forgotten and nobody notices:
     a pull missing here is simply absent from /api/health, so "is it
     running?" has no answer rather than a wrong one. The stores pull was
     added to odooSync.js and LIVE_PULLS on 2026-10-01 and did NOT appear
     here until it was caught by reading the health output — exactly the
     restated-list trap config/odooPulls.js was written to prevent. Adding a
     pull means adding it here too. */
  const wanted = [
    dispatch   && 'dispatch-daily-summary',
    mining     && 'mining-weighbridge-tickets',
    production && 'production-report-autofill',
    stores     && 'stores-gate-grn-issues',
    sales      && 'sales-register',
    odooDb     && 'cpp-autofill',
    odooDb     && 'waste-material-entries',
    odooDb     && 'production-stock-ledger',
  ].filter(Boolean);
  if (!wanted.length) return {};

  let rows;
  try {
    rows = (await db.query('SELECT * FROM odoo_sync_state')).rows;
  } catch (err) {
    // Table missing (migration 026 not applied yet) — say so, don't fail health over it.
    return { unavailable: { ok: true, status: 'unknown', note: 'sync state unreadable: ' + err.message } };
  }
  const byName = new Map(rows.map(r => [r.pull_name, r]));
  const out = {};
  for (const name of wanted) {
    out[name] = classifySync(byName.get(name), pullSchedule(name), { uptimeS: process.uptime() });
  }
  return out;
}

/* Heuristic, not a guarantee: compares device IDs (fs.stat().dev) of
   BACKUP_DIR and the app's own working directory. True only tells you
   they're the SAME filesystem/disk (a real problem — one disk failure
   loses both the database and its backups); false doesn't prove they're
   on genuinely independent physical disks (e.g. a remote DB_HOST makes
   this comparison uninformative — harmless in that case, just not useful). */
async function _sameDiskAsApp(dir) {
  try {
    const [dirStat, appStat] = await Promise.all([fsp.stat(dir), fsp.stat(process.cwd())]);
    return dirStat.dev === appStat.dev;
  } catch {
    return false;
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
    const sameDisk = await _sameDiskAsApp(dir);
    return {
      ok: ageH <= BACKUP_MAX_AGE_H && !sameDisk,
      age_hours: Math.round(ageH * 10) / 10, max_hours: BACKUP_MAX_AGE_H,
      same_disk_as_app: sameDisk,
      ...(sameDisk ? { warning: 'BACKUP_DIR appears to be on the same disk as the app — point it at a second disk or network share (see docs/RUNBOOK.md §4)' } : {}),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ── Compliance reminder job ─────────────────────────────────────────────
   Read straight from compliance_reminder_runs — NOT by requiring the
   service, which would pull mailer/watchdog into health and rebuild the
   health → watchdog → health cycle config/odooPulls.js exists to break.
   The job runs twice a day, so a successful real run older than 26 h is
   stale. Mail failures are reported but do not degrade health: that is the
   mail route's problem (RAID R-6), surfaced on the Settings page. */
const COMPLIANCE_MAX_AGE_H = 26;
function classifyComplianceRun(row, { scheduled }, { now = Date.now(), uptimeS = 0 } = {}) {
  if (!scheduled) return { ok: false, status: 'not_scheduled', note: 'COMPLIANCE_REMINDER_CRON is off — no reminders are evaluated' };
  const okAt  = row && row.last_success_at ? new Date(row.last_success_at).getTime() : null;
  const errAt = row && row.last_error_at   ? new Date(row.last_error_at).getTime()   : null;
  const base = { last_success_at: okAt ? new Date(okAt).toISOString() : null, max_age_hours: COMPLIANCE_MAX_AGE_H };
  if (errAt && (!okAt || errAt > okAt)) return { ok: false, status: 'failing', ...base, last_error_at: new Date(errAt).toISOString() };
  if (!okAt) {
    return uptimeS < COMPLIANCE_MAX_AGE_H * 3600
      ? { ok: true, status: 'starting', ...base, note: 'no run yet since start (runs 07:00 and 14:00 EAT)' }
      : { ok: false, status: 'never_run', ...base };
  }
  if ((now - okAt) / 3600000 > COMPLIANCE_MAX_AGE_H) return { ok: false, status: 'stale', ...base };
  return { ok: true, status: 'ok', ...base };
}

async function checkComplianceReminders() {
  try {
    const { rows: [r] } = await db.query(`
      SELECT MAX(finished_at) FILTER (WHERE ok)       AS last_success_at,
             MAX(finished_at) FILTER (WHERE ok = false) AS last_error_at
        FROM compliance_reminder_runs WHERE NOT dry_run`);
    const { rows: [m] } = await db.query(`
      SELECT MAX(created_at) FILTER (WHERE sent) AS last_sent_at,
             COUNT(*) FILTER (WHERE NOT sent AND created_at > NOW() - INTERVAL '7 days')::int AS failed_7d
        FROM compliance_mail_log`);
    const v = classifyComplianceRun(r, { scheduled: process.env.COMPLIANCE_REMINDER_CRON !== 'off' }, { uptimeS: process.uptime() });
    v.mail = { last_sent_at: m.last_sent_at, failed_7d: m.failed_7d };
    return v;
  } catch {
    // Tables missing (migration 038 not applied yet) — say so, don't fail health over it.
    return { ok: true, status: 'unknown', note: 'compliance tables not present' };
  }
}

async function deepHealth() {
  const [dbCheck, disk, backup, compliance] = await Promise.all([checkDb(), checkDisk(), checkBackup(), checkComplianceReminders()]);

  const odoo = checkOdoo();
  if (odoo && odoo.ok && dbCheck.ok) {
    odoo.sync = await checkOdooSync();
    // An overdue/failing/unscheduled pull is real staleness on someone's
    // report, so it degrades health — but only via the pull's own age, never
    // a live Odoo call, so one flaky poll can't do it.
    if (Object.values(odoo.sync).some(s => s.ok === false)) odoo.ok = false;
  }

  let status = 'ok';
  // 'not_configured' degrades too now (a plant with zero backups shouldn't
  // show perpetually green health) — backup.ok is undefined on that string,
  // so !backup.ok is already true for it; no separate branch needed.
  if (!disk.ok || !backup.ok || (odoo && odoo.ok === false) || compliance.ok === false) status = 'degraded';
  if (!dbCheck.ok) status = 'down';

  return {
    status,
    app: 'Lake Cement MIS Backend',
    version: '1.0.0',
    uptime_s: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: { db: dbCheck, disk, backup, odoo, compliance },
  };
}

/* checkOdoo is exported so scripts/odoo-test-connection.js reports exactly
   the same per-connector view as GET /api/health, instead of a second copy
   of these rules that can drift from this one. */
module.exports = { deepHealth, checkOdoo, checkOdooSync, classifySync, classifyComplianceRun };
