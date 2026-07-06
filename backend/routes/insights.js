/*
  routes/insights.js — Phase 8 "moat" analytics

  GET /api/insights/baseline/:formType?days=30   → per-field trailing stats
                                                   (anomaly check at entry)
  GET /api/insights/benchmark/:year/:month       → KPIs vs prev month / last
                                                   year / best-ever / rolling-3
  GET /api/insights/stoppages?from=&to=          → downtime Pareto + MTTR/MTBF
  GET /api/insights/search?q=                    → institutional memory search

  All authenticated; no role restriction — this is read-only insight, and
  wider access is the point (operators seeing baselines improves entries).
*/

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { validate, z, zDate } = require('../middleware/validate');
const { VALID_FORMS } = require('../config/forms');
const insights = require('../services/insights');

const router = express.Router();

const zYear  = z.coerce.number().int().min(1990).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);

router.get('/baseline/:formType',
  requireAuth,
  validate(z.object({ formType: z.enum(VALID_FORMS) }), 'params'),
  validate(z.object({
    days:   z.coerce.number().int().min(3).max(365).default(30),
    before: zDate.optional(), // exclusive upper bound — mainly for tests/backfill
  }), 'query'),
  async (req, res, next) => {
    try {
      const { formType } = req.validated.params;
      const { days, before } = req.validated.query;
      res.json(await insights.fieldBaseline(formType, { days, before }));
    } catch (err) { next(err); }
  });

router.get('/benchmark/:year/:month',
  requireAuth, validate(z.object({ year: zYear, month: zMonth }), 'params'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.params;
      res.json(await insights.benchmark(year, month));
    } catch (err) { next(err); }
  });

router.get('/stoppages',
  requireAuth, validate(z.object({ from: zDate, to: zDate }), 'query'),
  async (req, res, next) => {
    try {
      const { from, to } = req.validated.query;
      res.json(await insights.stoppageInsights(from, to));
    } catch (err) { next(err); }
  });

router.get('/search',
  requireAuth,
  validate(z.object({ q: z.string().trim().min(3).max(100) }), 'query'),
  async (req, res, next) => {
    try { res.json(await insights.searchMemory(req.validated.query.q)); }
    catch (err) { next(err); }
  });

module.exports = router;
