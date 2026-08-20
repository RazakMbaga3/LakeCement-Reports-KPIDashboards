/*
  routes/purchases.js — Purchase dashboard

  GET /api/purchases/dashboard?year=&month=   → aggregate dashboard payload

  Read-only for now (no manual entry, unlike Sales). Role-gated server-side
  to COMMERCIAL_VIEW_ROLES (config/commercialAccess.js), mirroring the
  sidebar's canViewSales() client-side gate — previously this was open to
  any authenticated role with no server-side check at all.
*/
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const purchases = require('../services/purchases');
const { COMMERCIAL_VIEW_ROLES } = require('../config/commercialAccess');

const router = express.Router();

const zYear  = z.coerce.number().int().min(2020).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);

router.get('/dashboard',
  requireAuth, requireRole(...COMMERCIAL_VIEW_ROLES),
  validate(z.object({ year: zYear.optional(), month: zMonth.optional() }), 'query'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.query;
      res.json(await purchases.getDashboard(year, month));
    } catch (err) { next(err); }
  });

module.exports = router;
