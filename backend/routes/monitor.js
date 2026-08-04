/*
  routes/monitor.js — observability endpoints

  GET  /api/monitor/summary        → health + recent logins/failed attempts,
                                     overrides, client errors, alerts (admin/md/it)
  GET  /api/monitor/alerts         → recent fired alerts (admin/md/it)
  POST /api/monitor/watchdog/run   → run the watchdog now; body {date?} to
                                     check a specific day (admin/md/it)
  GET  /api/monitor/odoo/test      → Odoo connectivity check — version +
                                     login, no data pulled (admin/md/it)
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
const odoo    = require('../services/odooClient');
const metrics = require('../services/metrics');

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
