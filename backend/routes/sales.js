/*
  routes/sales.js — Sales dashboard

  GET  /api/sales/dashboard?year=&month=   → aggregate dashboard payload
  GET  /api/sales/territories              → division/zone/officer roster
                                              (form + dashboard both need it)
  POST /api/sales/targets                  → set an interim manual target

  Read access is open to any authenticated role, same philosophy as
  routes/insights.js — visibility is controlled client-side by the
  sidebar's canViewSales() gate; server-side role restriction is reserved
  for writes.
*/
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const sales = require('../services/sales');

const router = express.Router();

const zYear  = z.coerce.number().int().min(2020).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);

router.get('/dashboard',
  requireAuth,
  validate(z.object({ year: zYear.optional(), month: zMonth.optional() }), 'query'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.query;
      res.json(await sales.getDashboard(year, month));
    } catch (err) { next(err); }
  });

router.get('/territories',
  requireAuth,
  async (req, res, next) => {
    try { res.json(await sales.getTerritories()); }
    catch (err) { next(err); }
  });

const targetBody = z.object({
  targetMonth: z.string().regex(/^\d{4}-\d{2}$/, 'must be YYYY-MM'),
  officerCode: z.string().trim().min(1).max(30), // '_company' for a company-wide target
  targetMt: z.coerce.number().finite().nonnegative(),
});

router.post('/targets',
  requireAuth, requireRole('sales', 'admin', 'md'),
  validate(targetBody, 'body'),
  async (req, res, next) => {
    try {
      const { targetMonth, officerCode, targetMt } = req.validated.body;
      const monthDate = targetMonth + '-01';

      /* officer_code has no DB-level FK (see migration 007 — a foreign key
         can't express "either '_company' or a valid officer"), so that
         check lives here instead. */
      if (officerCode !== '_company') {
        const exists = await db.query(
          `SELECT 1 FROM sales_territories WHERE officer_code = $1 AND active`, [officerCode]
        );
        if (!exists.rows.length) {
          return res.status(400).json({ error: `Unknown officer_code "${officerCode}" — not an active sales_territories row.` });
        }
      }

      await db.query(
        `INSERT INTO sales_targets (target_month, officer_code, grade_key, target_mt, source, set_by)
         VALUES ($1, $2, NULL, $3, 'manual', $4)
         ON CONFLICT (target_month, officer_code, grade_key) DO UPDATE SET
           target_mt = EXCLUDED.target_mt, source = 'manual', set_by = EXCLUDED.set_by, updated_at = NOW()`,
        [monthDate, officerCode, targetMt, req.user.id]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

module.exports = router;
