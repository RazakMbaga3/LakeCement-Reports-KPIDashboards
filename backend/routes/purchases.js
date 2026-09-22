/*
  routes/purchases.js — Purchase dashboard

  GET /api/purchases/dashboard → aggregate dashboard payload

  Period is chosen with `mode` (2026-09-22 — it used to be month only):
    (none) | month   ?year=&month=
    quarter          ?mode=quarter&year=&quarter=1-4
    ytd              ?mode=ytd&year=
    custom           ?mode=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
  Omitted parts default to the current month/quarter/year, so the bare
  path still answers exactly as it did. services/purchases.js
  resolvePeriod() owns the meaning of each mode; this file only validates.

  Read-only for now (no manual entry, unlike Sales). Role-gated server-side
  to PURCHASE_VIEW_ROLES (config/commercialAccess.js), mirroring the
  sidebar's canViewPurchases() client-side gate — split out from Sales'
  COMMERCIAL_VIEW_ROLES now that Purchase has its own role/department.
*/
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const purchases = require('../services/purchases');
const { PURCHASE_VIEW_ROLES } = require('../config/commercialAccess');

const router = express.Router();

const zYear    = z.coerce.number().int().min(2020).max(2100);
const zMonth   = z.coerce.number().int().min(1).max(12);
const zQuarter = z.coerce.number().int().min(1).max(4);
/* Strict ISO only. The Odoo endpoint rejects anything else outright on the
   production server (see odooDashboardClient.js), so a loose date here
   would fail far downstream with a Postgres datestyle error instead of a
   400 naming the field. */
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const zQuery = z.object({
  mode: z.enum(['month', 'quarter', 'ytd', 'custom']).optional(),
  year: zYear.optional(),
  month: zMonth.optional(),
  quarter: zQuarter.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
}).refine(q => q.mode !== 'custom' || (q.from && q.to), {
  message: 'mode=custom requires both from and to',
  path: ['from'],
});

router.get('/dashboard',
  requireAuth, requireRole(...PURCHASE_VIEW_ROLES),
  validate(zQuery, 'query'),
  async (req, res, next) => {
    try {
      res.json(await purchases.getDashboard(req.validated.query));
    } catch (err) { next(err); }
  });

module.exports = router;
