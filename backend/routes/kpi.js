/*
  routes/kpi.js — Monthly KPI Targets & Actuals

  GET  /api/kpi/summary/:year/:month      → executive summary — all depts
  GET  /api/kpi/ytd/:dept/:year           → year-to-date aggregation
  GET  /api/kpi/:dept/:year/:month        → get KPIs for a dept/month
  PUT  /api/kpi/:dept/:year/:month        → save KPI targets or actuals

  Every request is validated (middleware/validate.js) before it touches SQL;
  handlers read the parsed (coerced-to-number) values from req.validated.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth }          = require('../middleware/auth');
const { requireKpiDeptAccess } = require('../middleware/kpiAccess');
const { validate, z, zNumeric } = require('../middleware/validate');

const router = express.Router();

const zYear  = z.coerce.number().int().min(2000).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);
const zDept  = z.string().regex(/^[a-z0-9_-]+$/i, 'must be a department key').max(50);

const yearMonthParams     = z.object({ year: zYear, month: zMonth });
const deptYearParams      = z.object({ dept: zDept, year: zYear });
const deptYearMonthParams = z.object({ dept: zDept, year: zYear, month: zMonth });

// ── GET /api/kpi/summary/:year/:month ───────────────────────
// Executive summary — all departments, one month
router.get('/summary/:year/:month',
  requireAuth, validate(yearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month } = req.validated.params;
      const result = await db.query(
        `SELECT department, kpi_key, target, actual, unit
         FROM kpi_monthly
         WHERE year = $1 AND month = $2
         ORDER BY department, kpi_key`,
        [year, month]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/ytd/:dept/:year ────────────────────────────
// Year-to-date: sum/avg actuals Jan → current month
router.get('/ytd/:dept/:year',
  requireAuth, validate(deptYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year } = req.validated.params;
      const result = await db.query(
        `SELECT kpi_key, unit,
                SUM(target) AS ytd_target,
                SUM(actual) AS ytd_actual,
                COUNT(*) AS months_reported
         FROM kpi_monthly
         WHERE department = $1 AND year = $2
         GROUP BY kpi_key, unit
         ORDER BY kpi_key`,
        [dept, year]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/:dept/:year/:month ─────────────────────────
router.get('/:dept/:year/:month',
  requireAuth, validate(deptYearMonthParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const result = await db.query(
        `SELECT * FROM kpi_monthly WHERE department=$1 AND year=$2 AND month=$3 ORDER BY kpi_key`,
        [dept, year, month]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── PUT /api/kpi/:dept/:year/:month ─────────────────────────
// Save KPI values — dept-aware: admin/management edit any dept, each
// department HOD only their own (see config/kpiAccess.js). md is view-only.
// Body: [ { kpi_key, target, actual, unit }, ... ]
const kpiRowsBody = z.array(z.object({
  kpi_key: z.string().trim().min(1).max(100),
  target:  zNumeric.optional(),
  actual:  zNumeric.optional(),
  unit:    z.string().max(20).optional().default(''),
})).min(1, 'KPI data must be a non-empty array').max(500);

router.put('/:dept/:year/:month',
  requireAuth, requireKpiDeptAccess,
  validate(deptYearMonthParams, 'params'), validate(kpiRowsBody, 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const kpis = req.validated.body;

      // Upsert each KPI row
      for (const kpi of kpis) {
        await db.query(`
          INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
          ON CONFLICT (department, year, month, kpi_key)
          DO UPDATE SET target=EXCLUDED.target, actual=EXCLUDED.actual, unit=EXCLUDED.unit,
                        updated_by=$8, updated_at=NOW()
        `, [dept, year, month, kpi.kpi_key, kpi.target ?? null, kpi.actual ?? null, kpi.unit ?? '', req.user.id]);
      }

      await db.query(
        'INSERT INTO audit_log (user_id, username, action, form_type, ip_address) VALUES ($1,$2,$3,$4,$5)',
        [req.user.id, req.user.username, 'KPI_UPDATE', `${dept}/${year}/${month}`, req.ip]
      );

      res.json({ success: true, updated: kpis.length });
    } catch (err) { next(err); }
  });

module.exports = router;
