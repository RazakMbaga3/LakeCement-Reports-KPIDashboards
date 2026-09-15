/*
  routes/sales.js — Sales dashboard

  GET  /api/sales/dashboard?year=&month=   → aggregate dashboard payload
  GET  /api/sales/territories              → division/zone/officer roster
                                              (form + dashboard both need it)
  POST /api/sales/targets                  → set an interim manual target

  Read access (dashboard/territories) is role-gated server-side to
  COMMERCIAL_VIEW_ROLES (config/commercialAccess.js), mirroring the
  sidebar's canViewSales() client-side gate — previously this was open to
  any authenticated role with no server-side check at all.
*/
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const sales = require('../services/sales');
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
      res.json(await sales.getDashboard(year, month));
    } catch (err) { next(err); }
  });

router.get('/territories',
  requireAuth, requireRole(...COMMERCIAL_VIEW_ROLES),
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

      /* Upsert + its audit_log row in one transaction, the same way
         routes/reports.js writes a form submission: a target the caller
         sees as accepted must not be able to land without its entry in the
         trail. */
      await db.withTransaction(async (client) => {
        /* Read the figure about to be replaced. sales_targets keeps no
           history — the upsert below overwrites target_mt in place — so if
           the old value isn't captured here, "who moved this month's target,
           and from what" is unanswerable afterwards. routes/formula.js logs
           the superseded value for exactly this reason. */
        const { rows: [prev] } = await client.query(
          `SELECT target_mt FROM sales_targets
            WHERE target_month = $1 AND officer_code = $2 AND grade_key = '_all'`,
          [monthDate, officerCode]
        );

        await client.query(
          /* grade_key is always the '_all' sentinel here, never NULL — Postgres
             treats every NULL as distinct under UNIQUE, which would silently
             defeat this ON CONFLICT and insert a duplicate row on every
             correction instead of updating (see migration 008's header). */
          `INSERT INTO sales_targets (target_month, officer_code, grade_key, target_mt, source, set_by)
           VALUES ($1, $2, '_all', $3, 'manual', $4)
           ON CONFLICT (target_month, officer_code, grade_key) DO UPDATE SET
             target_mt = EXCLUDED.target_mt, source = 'manual', set_by = EXCLUDED.set_by, updated_at = NOW()`,
          [monthDate, officerCode, targetMt, req.user.id]
        );

        /* form_type carries the identity of the row changed, as kpi.js does
           with `dept/year/month`; record_date carries the month it applies
           to, which for a target is honestly a single date — sales_targets
           already stores the period anchored at the first of the month. */
        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.user.id, req.user.username, 'SALES_TARGET_SET',
           `${targetMonth}/${officerCode}`, monthDate,
           `${officerCode === '_company' ? 'company-wide' : 'officer ' + officerCode} target for ${targetMonth}: ` +
           `${prev ? Number(prev.target_mt) + ' → ' : 'set to '}${targetMt} MT`,
           req.ip]
        );
      });

      res.json({ ok: true });
    } catch (err) { next(err); }
  });

module.exports = router;
