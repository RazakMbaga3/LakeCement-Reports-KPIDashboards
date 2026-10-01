/*
  routes/stores.js — Raw Material and Stores data, read from the tables
  odooStoresSync.js fills (migration 031).

    GET /api/stores/raw-material?date=YYYY-MM-DD   receipts + pending GRN
    GET /api/stores/issues?date=&product=          consumption (diesel etc.)
    GET /api/stores/valuation?from=&to=            GRN-booked value by item
    GET /api/stores/freshness                      how current each feed is
    POST /api/stores/sync                          run the pull now

  Read access is RAWMAT_VIEW_ROLES (forms/access-registry.js) — the same
  list that already gates raw-material stock on the Executive Summary, so
  one rule covers both surfaces rather than this route inventing a second.

  POST /sync is narrower: it reaches out to a slow third-party ERP (15-55s)
  and writes to three tables, so it is admin/md/stores only and rate-limited
  by its own in-flight lock below. Everyone else waits for the schedule.
*/
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const report = require('../services/storesReport');
const storesSync = require('../services/odooStoresSync');
const { RAWMAT_VIEW_ROLES } = require('../../forms/access-registry.js');
const log = require('../services/logger');

const router = express.Router();

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const today = () => new Date().toISOString().slice(0, 10);

const canRead = [requireAuth, requireRole(...RAWMAT_VIEW_ROLES)];

router.get('/raw-material',
  ...canRead,
  validate(z.object({ date: zDate.optional() }), 'query'),
  async (req, res, next) => {
    try {
      const date = req.validated.query.date || today();
      const [receipts, pending, fresh] = await Promise.all([
        report.receiptsForDate(date),
        report.pendingGrn(date),
        report.freshness(),
      ]);
      res.json({
        date,
        rows: receipts.rows,
        /* Always present, even when empty — a consumer that only renders
           this when non-empty would hide the one case it exists for. */
        unassigned: receipts.unassigned,
        pending_grn: pending,
        freshness: fresh,
      });
    } catch (err) { next(err); }
  });

router.get('/issues',
  ...canRead,
  validate(z.object({
    date: zDate.optional(),
    product: z.string().max(240).optional(),
  }), 'query'),
  async (req, res, next) => {
    try {
      const { date, product } = req.validated.query;
      res.json(await report.issuesForDate(date || today(), { product: product || null }));
    } catch (err) { next(err); }
  });

router.get('/valuation',
  ...canRead,
  validate(z.object({ from: zDate, to: zDate }), 'query'),
  async (req, res, next) => {
    try {
      let { from, to } = req.validated.query;
      if (from > to) { const t = from; from = to; to = t; }
      res.json({ from, to, items: await report.valuationForRange(from, to) });
    } catch (err) { next(err); }
  });

router.get('/freshness', ...canRead, async (req, res, next) => {
  try { res.json({ feeds: await report.freshness() }); } catch (err) { next(err); }
});

/* ── Manual sync ───────────────────────────────────────────────────── */

/* One at a time, process-wide. Two officers both pressing Refresh would
   otherwise put two 15-55s pulls on an ERP that also serves the plant's own
   Odoo users — the load pattern that crash-looped the droplet in September.
   The second caller is told to wait rather than queued, because by the time
   the first finishes their data is already fresh. */
let inFlight = null;

router.post('/sync',
  requireAuth, requireRole('admin', 'md', 'stores'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(31).optional() }), 'body'),
  async (req, res, next) => {
    if (inFlight) {
      return res.status(409).json({
        error: 'A stores sync is already running.',
        code: 'SYNC_IN_PROGRESS',
      });
    }
    const days = req.validated.body.days || 7;
    const to = today();
    const fromD = new Date();
    fromD.setDate(fromD.getDate() - (days - 1));
    const from = fromD.toISOString().slice(0, 10);

    try {
      inFlight = storesSync.pullAllStores(from, to);
      const out = await inFlight;
      log.info({ from, to, results: out.results, errors: out.errors }, 'manual stores sync');
      /* 207 when some datasets failed and some worked: the caller gets the
         partial result AND knows it is partial, instead of a 200 that looks
         complete or a 500 that throws away two good pulls. */
      res.status(out.errors.length ? 207 : 200).json(out);
    } catch (err) {
      next(err);
    } finally {
      inFlight = null;
    }
  });

module.exports = router;
