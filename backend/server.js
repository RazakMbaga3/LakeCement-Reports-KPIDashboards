/*
  server.js — Lake Cement MIS Backend Entry Point

  This file:
  1. Loads configuration from .env
  2. Creates the Express app
  3. Registers middleware (cors, json parsing)
  4. Mounts all route files under /api/...
  5. Starts listening on the configured port

  CONCEPT: Express app flow
  Every incoming request travels through this pipeline:
    Request → CORS check → JSON parse → Route match → Response
*/

require('./config/env');
const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const { rateLimit } = require('express-rate-limit');
const logger        = require('./services/logger');
const pinoHttp      = require('pino-http');
const metrics       = require('./services/metrics');
const { deepHealth } = require('./services/health');
const { monitorRouter, clientErrorsRouter, metricsAuth, metricsHandler } = require('./routes/monitor');

// Import route files
const authRoutes    = require('./routes/auth');
const reportsRoutes = require('./routes/reports');
const kpiRoutes     = require('./routes/kpi');
const formulaRoutes = require('./routes/formula');
const misRoutes     = require('./routes/mis');
const insightsRoutes = require('./routes/insights');
const quarryRoutes  = require('./routes/quarry');
const stoppageRoutes = require('./routes/stoppage');
const salesRoutes   = require('./routes/sales');
const purchasesRoutes = require('./routes/purchases');
const approvalsRoutes = require('./routes/approvals');
const adminRoutes     = require('./routes/admin');

const app  = express();
const PORT = process.env.PORT || 5000;

// Behind Nginx/IIS (Phase 7 deployment) req.ip must come from
// X-Forwarded-For or rate limiting and audit logs see only the proxy.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// Loud warnings for unsafe configuration — better than silently running open
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes('change-me')) {
  logger.warn('JWT_SECRET is missing or a placeholder — set a real secret in .env');
}
if ((process.env.ALLOWED_ORIGIN || '*').trim() === '*') {
  logger.warn('CORS is open to all origins (ALLOWED_ORIGIN=*) — restrict in production');
}
if (!process.env.BACKUP_DIR) {
  logger.warn('BACKUP_DIR is not set — nightly backups are OFF and /api/health will report degraded; there is no disaster-recovery path until this is configured');
}

// ── MIDDLEWARE ───────────────────────────────────────────────

// Security headers (X-Content-Type-Options, HSTS, frame denial, …)
app.use(helmet());

// CORS — allows the browser (on the same network) to call this API.
// ALLOWED_ORIGIN accepts a comma-separated list of exact origins,
// e.g. "http://192.168.1.20,http://mis.lakecement.local"
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  // PATCH added 2026-09-03 for routes/admin.js's partial user update. Its
  // absence only bit in development, where the page (:3000) and the API
  // (:5000) are separate origins so the preflight actually runs — in
  // production nginx serves both from one origin and no preflight happens.
  // A route that works on the droplet and fails on a developer's machine is
  // worse than one that fails everywhere, so the list now matches the verbs
  // the API really answers.
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Renewed-Token'], // sliding-session renewal (middleware/auth.js)
}));

/* Rate-limit CREDENTIAL SUBMISSION — blunts password brute-forcing from one
   IP; the per-account lockout in routes/auth.js covers distributed attempts.

   Scoped to the two endpoints that take a password, NOT to all of /api/auth.
   The whole mount used to be limited at 30 requests / 5 minutes / IP, but
   auth.js's _verifySessionOrRedirect() calls GET /api/auth/me on EVERY page
   load, and the limiter keys on IP — so the entire plant sitting behind one
   office NAT shared a 30-request budget. Thirty page views between them (a
   couple of minutes of ordinary dashboard use) exhausted it, after which
   nobody could log in until the window rolled. /me and /logout are
   authenticated session calls, not credential guesses; they don't belong
   behind a brute-force limiter. */
const credentialRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: parseInt(process.env.AUTH_RATE_LIMIT || '30', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts from this device. Wait a few minutes and try again.' },
});
app.use('/api/auth/login', credentialRateLimit);
/* The email-link routes are unauthenticated by necessity — they exist to
   reach someone who cannot sign in — so they sit behind the same limiter.
   forgot-password answers identically for known and unknown addresses, but
   without a limit it would still be a free bulk-mail trigger; set-password
   and verify-email are the only places a token can be guessed at. */
app.use('/api/auth/forgot-password', credentialRateLimit);
app.use('/api/auth/set-password',    credentialRateLimit);
app.use('/api/auth/verify-email',    credentialRateLimit);
app.use('/api/auth/token',           credentialRateLimit);
app.use('/api/auth/change-password', credentialRateLimit);

// Parse incoming JSON request bodies
// Without this, req.body would be undefined
app.use(express.json({ limit: '10mb' }));

// Structured request logging (pino → stdout + daily-rotated backend/logs/)
// and Prometheus request metrics. Health/metrics polls stay out of the log.
app.use(pinoHttp({
  logger,
  autoLogging: { ignore: req => req.url === '/api/health' || req.url === '/api/metrics' },
  customProps: req => ({ user: req.user && req.user.username }),
  serializers: {
    req: req => ({ method: req.method, url: req.url }),
    res: res => ({ status: res.statusCode }),
  },
}));
app.use(metrics.middleware);

// ── API ROUTES ───────────────────────────────────────────────
// All routes are prefixed with /api/
// So the browser calls: http://server-ip:5000/api/auth/login

app.use('/api/auth',    authRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/kpi',     kpiRoutes);
app.use('/api/formula', formulaRoutes);
app.use('/api/mis',      misRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/quarry',   quarryRoutes);
app.use('/api/stoppage', stoppageRoutes);
app.use('/api/sales',    salesRoutes);
app.use('/api/purchases', purchasesRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/admin',    adminRoutes);
app.use('/api/monitor',  monitorRouter);
app.get('/api/metrics', metricsAuth, metricsHandler);

// Browser error reports — rate-limited hard (they can come from any page,
// authenticated or not) so a crash-looping tab can't flood the table.
app.use('/api/client-errors', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: parseInt(process.env.CLIENT_ERROR_RATE_LIMIT || '60', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many error reports from this device.' },
}), clientErrorsRouter);

// ── SCHEDULED JOBS ───────────────────────────────────────────
// Morning digest (needs SMTP + recipients) and the alerting watchdog
// (always on — deep health, missed entries, disk, backup). Failures are
// logged, never fatal. Manual triggers: POST /api/mis/digest/send,
// POST /api/monitor/watchdog/run.
{
  const cron = require('node-cron');

  if (process.env.SMTP_HOST && process.env.DIGEST_TO) {
    const { sendDigest } = require('./services/digest');
    const spec = process.env.DIGEST_CRON || '0 6 * * *';
    cron.schedule(spec, async () => {
      try {
        const r = await sendDigest();
        logger.info({ digest: r.sent ? r.to : r.reason }, 'daily digest run');
      } catch (err) {
        logger.error({ err }, 'daily digest failed');
      }
    });
    logger.info(`morning digest scheduled (${spec}) → ${process.env.DIGEST_TO}`);
  }

  if (process.env.BACKUP_DIR && process.env.BACKUP_CRON !== 'off') {
    const { runBackup } = require('./services/backup');
    const spec = process.env.BACKUP_CRON || '30 2 * * *';
    cron.schedule(spec, async () => {
      try {
        const r = await runBackup();
        logger.info({ file: r.file, bytes: r.bytes, pruned: r.pruned.length }, 'nightly backup complete');
      } catch (err) {
        // health/watchdog will also flag the growing backup age
        logger.error({ err }, 'nightly backup FAILED');
      }
    });
    logger.info(`nightly backup scheduled (${spec}) → ${process.env.BACKUP_DIR}`);
  }

  // Restore drill (proves the newest backup actually restores) — was a
  // 100%-manual "run this monthly" step (docs/RUNBOOK.md §4) with nothing
  // enforcing it; a plant could skip it for a year with no signal. Default
  // 1st of the month at 03:30, after the nightly backup. Failure fires a
  // real alert (not just a log line) — a broken/unrestorable backup is
  // exactly the kind of thing that must not go unnoticed.
  if (process.env.BACKUP_DIR && process.env.RESTORE_DRILL_CRON !== 'off') {
    const { runRestoreDrill } = require('./services/restoreDrill');
    const { fireAlert } = require('./services/watchdog');
    const spec = process.env.RESTORE_DRILL_CRON || '30 3 1 * *';
    cron.schedule(spec, async () => {
      try {
        const r = await runRestoreDrill();
        if (r.ok) {
          logger.info({ result: r }, 'monthly restore drill passed');
        } else {
          logger.error({ result: r }, 'monthly restore drill FAILED');
          await fireAlert('restore-drill-failed', 'Monthly restore drill failed: ' + (r.error || JSON.stringify(r)));
        }
      } catch (err) {
        logger.error({ err }, 'monthly restore drill run crashed');
        await fireAlert('restore-drill-failed', 'Monthly restore drill crashed: ' + err.message).catch(() => {});
      }
    });
    logger.info(`monthly restore drill scheduled (${spec})`);
  }

  if (process.env.WATCHDOG_CRON !== 'off') {
    const { runWatchdog } = require('./services/watchdog');
    const spec = process.env.WATCHDOG_CRON || '*/15 * * * *';
    cron.schedule(spec, async () => {
      try {
        const r = await runWatchdog();
        if (r.fired.length) logger.warn({ fired: r.fired, email: r.email }, 'watchdog alerts fired');
      } catch (err) {
        logger.error({ err }, 'watchdog run failed');
      }
    });
    logger.info(`watchdog scheduled (${spec})`);
  }

  // Odoo pull (Phase 4 — see services/odooSync.js). Two independent Odoo
  // connections can each unlock this: ODOO_URL (generic XML-RPC connector,
  // no pulls use it yet) or ODOO_DISPATCH_URL (the dispatch-report
  // connector, wired up and pulling since 2026-08-05). Either one present
  // is enough to schedule the job — odooSync.js's own PULLS list decides
  // what actually runs.
  if ((process.env.ODOO_URL || process.env.ODOO_DISPATCH_URL) && process.env.ODOO_SYNC_CRON !== 'off') {
    const { runOdooSync } = require('./services/odooSync');
    const spec = process.env.ODOO_SYNC_CRON || '0 5 * * *'; // 05:00, ahead of the 06:00 digest
    cron.schedule(spec, async () => {
      try {
        const r = await runOdooSync();
        logger.info({ ran: r.ran }, 'odoo sync run');
      } catch (err) {
        logger.error({ err }, 'odoo sync failed');
      }
    });
    logger.info(`odoo sync scheduled (${spec})`);
  }
}

// ── HEALTH CHECK ─────────────────────────────────────────────
// Deep health: DB connectivity + latency, disk free space, backup age.
// 200 for ok/degraded (body carries the detail), 503 when the DB is down —
// so LAN monitoring tools can alarm on status code alone.
// Unauthenticated by design; it exposes no data, only service state.
app.get('/api/health', async (req, res) => {
  const h = await deepHealth();
  res.status(h.status === 'down' ? 503 : 200).json(h);
});

// ── SERVE FRONTEND (Production) ──────────────────────────────
// In production, Nginx serves the frontend.
// In development, the browser opens the HTML files directly.
// Uncomment these lines (and require 'path') if Node should serve it too:
// const path = require('path');
// app.use(express.static(path.join(__dirname, '..')));
// app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

// ── 404 HANDLER ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────
// Route handlers call next(err); the stack is logged here, and the client
// only ever sees a generic message — never internals.
app.use((err, req, res, next) => {
  logger.error({ err, method: req.method, path: req.path, user: req.user && req.user.username },
    'unhandled request error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── START SERVER ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Lake Cement MIS — Backend Server         ║');
  console.log(`║   Running on http://localhost:${PORT}         ║`);
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
});
