/*
  routes/kpi.js — Monthly KPI Targets & Actuals

  GET  /api/kpi/summary/:year/:month      → executive summary — all depts
  GET  /api/kpi/ytd/:dept/:year           → year-to-date aggregation
  GET  /api/kpi/fiscal/:dept/:fyStartYear → whole fiscal year (Apr→Mar), one dept
  GET  /api/kpi/range/:dept?from=&to=     → an arbitrary run of months, one dept
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
const { KPI_DEPTS } = require('../config/kpiAccess');

const router = express.Router();

const zYear  = z.coerce.number().int().min(2000).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);
/* A real department key, not just a plausible-looking string. The loose
   /^[a-z0-9_-]+$/ this used to be let a typo (or a stale client) create
   kpi_monthly rows under a department no page renders — invisible data that
   nothing ever reports. KPI_DEPTS is shared with the frontend via
   forms/access-registry.js. Reads stay permissive-by-shape and simply return
   [] for an unknown dept; only writes are constrained. */
const zDept     = z.string().regex(/^[a-z0-9_-]+$/i, 'must be a department key').max(50);
const zRealDept = z.enum(KPI_DEPTS);

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

// ── GET /api/kpi/range/:dept?from=YYYY-MM&to=YYYY-MM ────────
// An arbitrary run of months for one department, in order.
//
// /fiscal answers "one Apr→Mar year", which is the right shape for the
// dashboard's 12-column tracker but the wrong one for looking at a stretch
// of history: Jan–Jun 2026 straddles two fiscal years, so it takes two calls
// and still cannot be laid out as consecutive columns. This backs the
// "Last 12 Months" view, where the columns are a rolling window ending at
// the selected month and crossing the April boundary freely.
//
// Registered ahead of the generic /:dept/:year/:month for the same reason
// /fiscal is — Express matches top-to-bottom and both are 3 segments deep.
const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');
const rangeQuery = z.object({ from: zPeriod, to: zPeriod });

router.get('/range/:dept',
  requireAuth,
  validate(z.object({ dept: zDept }), 'params'),
  validate(rangeQuery, 'query'),
  async (req, res, next) => {
    try {
      const { dept } = req.validated.params;
      const { from, to } = req.validated.query;
      const n = p => Number(p.slice(0, 4)) * 100 + Number(p.slice(5, 7));
      const [lo, hi] = [n(from), n(to)].sort((a, b) => a - b);
      const result = await db.query(
        `SELECT year, month, kpi_key, target, actual, unit, remarks
         FROM kpi_monthly
         WHERE department = $1 AND (year * 100 + month) BETWEEN $2 AND $3
         ORDER BY kpi_key, year, month`,
        [dept, lo, hi]
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
// Body: [ { kpi_key, target?, actual?, unit?, remarks?, clear? }, ... ]
//
// `clear` is how a field is REMOVED. Every other field COALESCEs onto the
// stored row so a remarks-only save doesn't wipe the actual (and vice versa)
// — which also meant a wrong figure could never be taken back out: omitting
// `actual` kept it, and sending null kept it too. Listing a field name in
// `clear` sets that column to NULL explicitly.
const kpiRowsBody = z.array(z.object({
  kpi_key: z.string().trim().min(1).max(100),
  target:  zNumeric.optional(),
  actual:  zNumeric.optional(),
  unit:    z.string().max(20).optional().default(''),
  remarks: z.string().max(2000).optional(),
  clear:   z.array(z.enum(['target', 'actual', 'remarks'])).max(3).optional(),
})).min(1, 'KPI data must be a non-empty array').max(500);

const deptYearMonthWrite = z.object({ dept: zRealDept, year: zYear, month: zMonth });

router.put('/:dept/:year/:month',
  requireAuth, requireKpiDeptAccess,
  validate(deptYearMonthWrite, 'params'), validate(kpiRowsBody, 'body'),
  async (req, res, next) => {
    try {
      const { dept, year, month } = req.validated.params;
      const kpis = req.validated.body;

      /* One transaction for the whole save AND its audit row. Previously each
         upsert was its own statement with the audit insert separate, so a
         failure part-way through left some KPIs written, some not, and no
         record that anything had been attempted. withTransaction() is the
         same helper routes/reports.js already uses for form submissions. */
      const touched = await db.withTransaction(async (client) => {
        const rows = [];
        for (const kpi of kpis) {
          const clear = new Set(kpi.clear || []);
          const result = await client.query(`
            INSERT INTO kpi_monthly (department, year, month, kpi_key, target, actual, unit, remarks, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            ON CONFLICT (department, year, month, kpi_key)
            DO UPDATE SET
              target  = CASE WHEN $10 THEN NULL ELSE COALESCE(EXCLUDED.target,  kpi_monthly.target)  END,
              actual  = CASE WHEN $11 THEN NULL ELSE COALESCE(EXCLUDED.actual,  kpi_monthly.actual)  END,
              remarks = CASE WHEN $12 THEN NULL ELSE COALESCE(EXCLUDED.remarks, kpi_monthly.remarks) END,
              unit    = CASE WHEN EXCLUDED.unit = '' THEN kpi_monthly.unit ELSE EXCLUDED.unit END,
              updated_by = $9, updated_at = NOW()
            RETURNING kpi_key, target, actual, remarks
          `, [
            dept, year, month, kpi.kpi_key,
            clear.has('target') ? null : (kpi.target ?? null),
            clear.has('actual') ? null : (kpi.actual ?? null),
            kpi.unit ?? '',
            clear.has('remarks') ? null : (kpi.remarks ?? null),
            req.user.id,
            clear.has('target'), clear.has('actual'), clear.has('remarks'),
          ]);
          rows.push(result.rows[0]);
        }

        /* Record WHAT changed, not just that something did. The override flow
           (routes/formula.js) has always logged a mandatory reason and the
           value it superseded; a KPI_UPDATE logged only "dept/year/month",
           leaving no way to answer "who changed this figure, and to what". */
        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [req.user.id, req.user.username, 'KPI_UPDATE', `${dept}/${year}/${month}`,
            rows.map(r => {
              const bits = [];
              if (r.actual  !== null) bits.push('actual=' + r.actual);
              if (r.target  !== null) bits.push('target=' + r.target);
              if (r.remarks !== null) bits.push('remarks="' + String(r.remarks).slice(0, 80) + '"');
              return r.kpi_key + ' -> ' + (bits.length ? bits.join(', ') : 'cleared');
            }).join('; ').slice(0, 4000),
            req.ip]
        );

        return rows;
      });

      res.json({ success: true, updated: touched.length });
    } catch (err) { next(err); }
  });

module.exports = router;
