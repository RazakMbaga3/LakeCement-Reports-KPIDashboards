/*
  routes/kpi.js — Monthly KPI Targets & Actuals

  GET  /api/kpi/summary/:year/:month      → executive summary — all depts
  GET  /api/kpi/ytd/:dept/:year           → year-to-date aggregation
  GET  /api/kpi/fiscal/:dept/:fyStartYear → whole fiscal year (Apr→Mar), one dept
  GET  /api/kpi/:dept/:year/:month        → get KPIs for a dept/month
  PUT  /api/kpi/:dept/:year/:month        → save KPI targets or actuals

  Every request is validated (middleware/validate.js) before it touches SQL;
  handlers read the parsed (coerced-to-number) values from req.validated.

  Lake Cement's business year runs April → March, not calendar Jan-Dec (see
  app.js's calMonthToFiscalPos/fiscalPosToCalYear on the frontend for the
  full convention). /fiscal is registered ahead of the generic
  /:dept/:year/:month route below — Express matches routes top-to-bottom,
  and both have a 3-segment shape after /api/kpi, so if the generic route
  came first it would swallow /fiscal/X/Y requests (dept='fiscal',
  year='X', which fails zYear validation) before this handler ever runs.
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
        `SELECT department, kpi_key, target, actual, unit, remarks
         FROM kpi_monthly
         WHERE year = $1 AND month = $2
         ORDER BY department, kpi_key`,
        [year, month]
      );
      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── GET /api/kpi/ytd/:dept/:year ────────────────────────────
// Year-to-date: sum/avg actuals Jan → current month. NOT currently called
// by the dashboard (the live YTD view is client-side column show/hide
// against /fiscal's data, see app.js) and NOT fiscal-year-aware — plain
// calendar-year aggregation. Fix this if it ever gets a real caller.
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

// ── GET /api/kpi/fiscal/:dept/:fyStartYear ──────────────────
// Whole fiscal year in one call (Apr fyStartYear → Mar fyStartYear+1) —
// powers the dashboard's 12-column month tracker without one request per
// month, and without the client having to know which two calendar years
// a fiscal year straddles.
const deptFyParams = z.object({ dept: zDept, fyStartYear: zYear });
router.get('/fiscal/:dept/:fyStartYear',
  requireAuth, validate(deptFyParams, 'params'),
  async (req, res, next) => {
    try {
      const { dept, fyStartYear } = req.validated.params;
      const result = await db.query(
        `SELECT year, month, kpi_key, target, actual, unit, remarks
         FROM kpi_monthly
         WHERE department = $1
           AND ( (year = $2     AND month BETWEEN 4 AND 12)
              OR (year = $2 + 1 AND month BETWEEN 1 AND 3) )
         ORDER BY kpi_key, year, month`,
        [dept, fyStartYear]
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
  remarks: z.string().optional(),
})).min(1, 'KPI data must be a non-empty array').max(500);

router.put('/:dept/:year/:month',
  requireAuth, requireKpiDeptAccess,
  validate(deptYearMonthParams, 'params'), validate(kpiRowsBody, 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const kpis = req.validated.body;

      // Upsert each KPI row. A remarks-only save (no target/actual in the
      // request, e.g. editing just the remark for an already-populated row)
      // must not clobber the existing target/actual — COALESCE onto the
      // current row rather than blindly overwriting with EXCLUDED.
      for (const kpi of kpis) {
        await db.query(`
          INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, remarks, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
          ON CONFLICT (department, year, month, kpi_key)
          DO UPDATE SET target=COALESCE(EXCLUDED.target, kpi_monthly.target),
                        actual=COALESCE(EXCLUDED.actual, kpi_monthly.actual),
                        unit=CASE WHEN EXCLUDED.unit = '' THEN kpi_monthly.unit ELSE EXCLUDED.unit END,
                        remarks=COALESCE(EXCLUDED.remarks, kpi_monthly.remarks),
                        updated_by=$9, updated_at=NOW()
        `, [dept, year, month, kpi.kpi_key, kpi.target ?? null, kpi.actual ?? null, kpi.unit ?? '', kpi.remarks ?? null, req.user.id]);
      }

      await db.query(
        'INSERT INTO audit_log (user_id, username, action, form_type, ip_address) VALUES ($1,$2,$3,$4,$5)',
        [req.user.id, req.user.username, 'KPI_UPDATE', `${dept}/${year}/${month}`, req.ip]
      );

      res.json({ success: true, updated: kpis.length });
    } catch (err) { next(err); }
  });

module.exports = router;
