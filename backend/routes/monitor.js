/*
  routes/monitor.js — observability endpoints

  GET  /api/monitor/summary        → health + recent logins/failed attempts,
                                     overrides, client errors, alerts (admin/md/it)
  GET  /api/monitor/alerts         → recent fired alerts (admin/md/it)
  POST /api/monitor/watchdog/run   → run the watchdog now; body {date?} to
                                     check a specific day (admin/md/it)
  GET  /api/monitor/odoo/test      → Odoo connectivity check — version +
                                     login, no data pulled (admin/md/it)
  POST /api/monitor/odoo/pull      → run a historical dispatch/mining/production
                                     pull for an explicit date range right now, from
                                     the browser (admin/md/it) — see below
  POST /api/client-errors          → browser error reports (rate-limited in
                                     server.js; token optional — login page
                                     errors matter too)
  GET  /api/metrics                → Prometheus text (admin/md/it JWT, or
                                     the static METRICS_TOKEN for scrapers)
*/

const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z, zDate } = require('../middleware/validate');
const { deepHealth }  = require('../services/health');
const { runWatchdog } = require('../services/watchdog');
const { VALID_FORMS, REPORTED_STATUSES } = require('../config/forms');
const odoo    = require('../services/odooClient');
const metrics = require('../services/metrics');
const { pullDispatchDailySummary } = require('../services/odooDispatchSync');
const { pullMiningTickets }        = require('../services/odooMiningSync');
const { pullAndAutofillProduction } = require('../services/odooProductionAutofill');

const MONITOR_ROLES = ['admin', 'md', 'it'];

/* ── /api/monitor ────────────────────────────────────────────── */
const monitorRouter = express.Router();

monitorRouter.get('/summary', requireAuth, requireRole(...MONITOR_ROLES), async (req, res, next) => {
  try {
    const [health, logins, overrides, clientErrors, alerts] = await Promise.all([
      deepHealth(),
      db.query(
        `SELECT username, action, ip_address, created_at FROM audit_log
         WHERE action IN ('LOGIN','LOGIN_FAILED','LOGIN_LOCKED','ACCOUNT_LOCKED','LOGOUT','PASSWORD_CHANGED')
         ORDER BY created_at DESC LIMIT 50`),
      db.query(
        `SELECT o.kpi_key, o.year, o.month, o.value_override, o.value_computed, o.reason,
                o.created_by_name, o.created_at, o.cleared_at
         FROM kpi_overrides o ORDER BY o.created_at DESC LIMIT 20`),
      db.query(
        `SELECT username, page, message, source, line, created_at
         FROM client_errors ORDER BY created_at DESC LIMIT 50`),
      db.query(`SELECT kind, detail, emailed, created_at FROM alerts ORDER BY created_at DESC LIMIT 50`),
    ]);
    res.json({
      health,
      logins: logins.rows,
      overrides: overrides.rows,
      clientErrors: clientErrors.rows,
      alerts: alerts.rows,
    });
  } catch (err) { next(err); }
});

/* ── GET /api/monitor/pipeline ────────────────────────────────
   "Is the system receiving and processing the expected data?" — the one
   question the monitor page existed to answer and could not.

   /summary already covers the Odoo side (odoo_sync_state) and the noise side
   (alerts, client errors). Neither says anything about daily_reports itself,
   so two real conditions on this database were invisible here:

     1. A form going SILENT. power-cons, materials, limestone and stoppage
        have no row at all after 2026-06-30. The watchdog does fire
        missed-entry:* daily, but that is one alert row per day per form —
        nothing anywhere states "power-cons last arrived 92 days ago", so a
        three-month outage reads as ordinary daily noise.

     2. Data that ARRIVED but does not COUNT. Every dispatch row is status
        'draft' (deliberate — migration 030 leaves Odoo-written days writable
        so an officer can finish the manual-only fields), and 'draft' is not
        in REPORTED_STATUSES. So ~2,000 MT/day of real Odoo tonnage sits in
        the table while every dispatch KPI reads null. "Rows exist" and "rows
        count" are different facts and the operator needs both.

   Everything here is derived from a live query; nothing is hardcoded and
   nothing reports OK by default. A form with no rows at all reports
   'never_received' rather than being omitted. */
monitorRouter.get('/pipeline', requireAuth, requireRole(...MONITOR_ROLES), async (req, res, next) => {
  try {
    const SILENT_AFTER_DAYS = parseFloat(process.env.FORM_SILENT_AFTER_DAYS || '3');

    const [perForm, orphans] = await Promise.all([
      db.query(
        `SELECT form_type,
                COUNT(*)                                              AS rows_total,
                COUNT(*) FILTER (WHERE status = ANY($1))              AS rows_counted,
                COUNT(*) FILTER (WHERE status = 'draft')              AS rows_draft,
                COUNT(*) FILTER (WHERE status = 'pending_approval')   AS rows_pending,
                COUNT(*) FILTER (WHERE status = 'rejected')           AS rows_rejected,
                MAX(record_date)                                      AS last_record_date,
                MAX(record_date) FILTER (WHERE status = ANY($1))      AS last_counted_date
           FROM daily_reports
          GROUP BY form_type`,
        [REPORTED_STATUSES]
      ),
      /* Rows whose form_type is not a form any more. VALID_FORMS gates
         WRITES only, so a retired or mistyped form_type keeps its rows
         forever and no read path ever looks at them again — invisible data
         that still occupies the table. */
      db.query(
        `SELECT form_type, COUNT(*) AS rows_total,
                MIN(record_date) AS first_record_date,
                MAX(record_date) AS last_record_date
           FROM daily_reports
          WHERE NOT (form_type = ANY($1))
          GROUP BY form_type
          ORDER BY form_type`,
        [VALID_FORMS]
      ),
    ]);

    const byForm = new Map(perForm.rows.map(r => [r.form_type, r]));
    const today  = new Date();
    const daysSince = (d) => d === null || d === undefined
      ? null
      : Math.floor((today - new Date(String(d).slice(0, 10) + 'T00:00:00Z')) / 86400000);

    const forms = VALID_FORMS.map((formType) => {
      const r = byForm.get(formType);
      if (!r) {
        return { formType, status: 'never_received', rowsTotal: 0, rowsCounted: 0,
                 note: 'no row has ever been submitted for this form' };
      }
      const counted   = Number(r.rows_counted);
      const ageAll    = daysSince(r.last_record_date);
      const ageCount  = daysSince(r.last_counted_date);

      /* Order matters: "arriving but not counting" is a different failure
         from "not arriving", and reporting it as merely stale would send an
         operator looking for a missing upload that is in fact already there. */
      let status, note;
      if (counted === 0) {
        status = 'not_counting';
        note = `${r.rows_total} row(s) present but none in a reported status — `
             + `${r.rows_draft} draft, ${r.rows_pending} pending, ${r.rows_rejected} rejected. `
             + 'These do not reach any KPI, the MIS pack or Entry Completeness.';
      } else if (ageCount !== null && ageCount > SILENT_AFTER_DAYS) {
        status = 'silent';
        note = `last reported day is ${ageCount} days old`
             + (ageAll !== null && ageAll < ageCount
                 ? ` — newer rows exist (${ageAll}d) but are not in a reported status`
                 : '');
      } else {
        status = 'ok';
        note = null;
      }

      return {
        formType, status, note,
        rowsTotal:   Number(r.rows_total),
        rowsCounted: counted,
        rowsDraft:   Number(r.rows_draft),
        rowsPending: Number(r.rows_pending),
        rowsRejected: Number(r.rows_rejected),
        lastRecordDate:  r.last_record_date  ? String(r.last_record_date).slice(0, 10)  : null,
        lastCountedDate: r.last_counted_date ? String(r.last_counted_date).slice(0, 10) : null,
        daysSinceLastRecord:  ageAll,
        daysSinceLastCounted: ageCount,
      };
    });

    res.json({
      generatedAt: new Date().toISOString(),
      silentAfterDays: SILENT_AFTER_DAYS,
      reportedStatuses: REPORTED_STATUSES,
      summary: {
        ok:            forms.filter(f => f.status === 'ok').length,
        silent:        forms.filter(f => f.status === 'silent').length,
        notCounting:   forms.filter(f => f.status === 'not_counting').length,
        neverReceived: forms.filter(f => f.status === 'never_received').length,
      },
      forms,
      /* Empty array is the healthy answer, and an empty array is what the UI
         should show as "none" rather than hiding the section. */
      orphanFormTypes: orphans.rows.map(r => ({
        formType: r.form_type,
        rowsTotal: Number(r.rows_total),
        firstRecordDate: String(r.first_record_date).slice(0, 10),
        lastRecordDate:  String(r.last_record_date).slice(0, 10),
        note: 'form_type is not in config/forms.js VALID_FORMS — no read path sees these rows',
      })),
    });
  } catch (err) { next(err); }
});

monitorRouter.get('/alerts', requireAuth, requireRole(...MONITOR_ROLES), async (req, res, next) => {
  try {
    const r = await db.query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (err) { next(err); }
});

monitorRouter.post('/watchdog/run',
  requireAuth, requireRole(...MONITOR_ROLES),
  validate(z.object({ date: zDate.optional() }), 'body'),
  async (req, res, next) => {
    try { res.json(await runWatchdog({ date: req.validated.body.date })); }
    catch (err) { next(err); }
  });

/* Connectivity check only — version + login, never any plant data. Lets
   ops confirm ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_API_KEY work from the
   Monitor page instead of SSHing into the server to run npm run odoo:test. */
monitorRouter.get('/odoo/test', requireAuth, requireRole(...MONITOR_ROLES), async (req, res) => {
  try {
    const version = await odoo.version();
    const uid = await odoo.authenticate();
    res.json({ connected: true, version, uid });
  } catch (err) {
    res.status(503).json({ connected: false, error: err.message });
  }
});

/* What each scheduled Odoo pull last did — the full detail behind
   GET /api/health's per-pull verdicts (which deliberately carry no raw
   error text, being public). Answers "is pulling actually live?" without
   server access: when it last succeeded, what it fetched (rows received,
   added, updated), and the last failure message if there was one. */
monitorRouter.get('/odoo/sync', requireAuth, requireRole(...MONITOR_ROLES), async (req, res, next) => {
  try {
    const { checkOdooSync } = require('../services/health');
    const { getSyncState } = require('../services/odooSync');
    const [verdicts, state] = await Promise.all([checkOdooSync(), getSyncState()]);
    res.json({
      live_cron:  process.env.ODOO_LIVE_SYNC_CRON !== 'off' ? (process.env.ODOO_LIVE_SYNC_CRON || '*/30 * * * *') : 'off',
      daily_cron: process.env.ODOO_SYNC_CRON !== 'off'      ? (process.env.ODOO_SYNC_CRON || '0 5 * * *')          : 'off',
      verdicts,
      state,
    });
  } catch (err) { next(err); }
});

/* Historical dispatch/mining pull, triggered from the browser instead of
   SSHing into the server to run scripts/odoo-{dispatch,mining}-pull.js —
   for a deployment where the person who needs the data doesn't hold
   droplet access, this IS the way to backfill a date range. Same
   underlying pull functions as those scripts and as odooSync.js's daily
   cron; this route only supplies an explicit range on demand.

   Capped at 31 days per call: both endpoints have no pagination and can
   return truncated JSON on large ranges (see odooMiningClient.js /
   odooDashboardClient.js headers) — better to force month-sized requests
   than let one call silently lose data mid-response. */
const MAX_PULL_DAYS = 31;

monitorRouter.post('/odoo/pull',
  requireAuth, requireRole(...MONITOR_ROLES),
  validate(z.object({
    pull: z.enum(['dispatch', 'mining', 'production']),
    from: zDate,
    to:   zDate,
    overwriteExcelDates: z.boolean().optional().default(false), // mining only; ignored otherwise
    dryRun: z.boolean().optional().default(false),               // production only; ignored otherwise
  }), 'body'),
  async (req, res, next) => {
    try {
      const { pull, from, to, overwriteExcelDates, dryRun } = req.validated.body;
      if (from > to) {
        return res.status(400).json({ error: `from (${from}) is after to (${to}).` });
      }
      const days = (new Date(to) - new Date(from)) / 86400000 + 1;
      if (days > MAX_PULL_DAYS) {
        return res.status(400).json({
          error: `Range is ${days} days — pull ${MAX_PULL_DAYS} days (about a month) or fewer at a time, `
               + 'to stay clear of Odoo\'s truncation limit on large ranges.',
        });
      }

      const result = pull === 'mining'     ? await pullMiningTickets(from, to, { overwriteExcelDates })
                   : pull === 'production' ? await pullAndAutofillProduction(from, to, { dryRun })
                   : await pullDispatchDailySummary(from, to);

      // `source`, not `pull`: production's own result carries a `pull` key
      // (its mirror-refresh summary) that would silently clobber this one
      // if it were spread in under the same name.
      res.json({ ok: true, source: pull, ...result });
    } catch (err) {
      // Odoo unreachable/timeout/truncated — a 502 (upstream failure), not
      // a 500: our code did its job, Odoo's response is what fell over.
      res.status(502).json({ ok: false, error: err.message });
    }
  });

/* ── /api/client-errors ──────────────────────────────────────── */
const clientErrorsRouter = express.Router();

const clientErrorBody = z.object({
  message: z.string().trim().min(1).max(500),
  source:  z.string().max(300).nullish(),
  line:    z.coerce.number().int().nullish(),
  page:    z.string().max(120).nullish(),
  stack:   z.string().max(2000).nullish(),
});

clientErrorsRouter.post('/', validate(clientErrorBody, 'body'), async (req, res, next) => {
  try {
    // Soft identification: a valid token names the user, an invalid or
    // missing one doesn't reject the report — errors on the login page count.
    let username = null;
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (token) {
      try { username = jwt.verify(token, process.env.JWT_SECRET).username; } catch { /* anonymous */ }
    }

    const { message, source, line, page, stack } = req.validated.body;
    await db.query(
      `INSERT INTO client_errors (username, page, message, source, line, stack, user_agent, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [username, page || null, message, source || null, line ?? null, stack || null,
       (req.headers['user-agent'] || '').slice(0, 300), req.ip]
    );
    // Retention: keep 60 days
    await db.query(`DELETE FROM client_errors WHERE created_at < NOW() - INTERVAL '60 days'`);
    res.json({ logged: true });
  } catch (err) { next(err); }
});

/* ── /api/metrics ────────────────────────────────────────────── */
function metricsAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (process.env.METRICS_TOKEN && token === process.env.METRICS_TOKEN) return next();
  return requireAuth(req, res, () => requireRole(...MONITOR_ROLES)(req, res, next));
}

async function metricsHandler(req, res, next) {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) { next(err); }
}

module.exports = { monitorRouter, clientErrorsRouter, metricsAuth, metricsHandler };
