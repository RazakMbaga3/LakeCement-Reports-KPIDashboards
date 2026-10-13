/*
  routes/mis.js — server-rendered MIS reports & distribution

  GET  /api/mis/daily/:date            → daily report payload (JSON)
  GET  /api/mis/daily/:date/html      → printable HTML (browser print → PDF)
  GET  /api/mis/daily/:date/xlsx      → Excel workbook download
  GET  /api/mis/daily-summary/:date    → plant-head Daily Summary Report (JSON),
                                         sections filtered by the caller's role
  GET  /api/mis/monthly/:year/:month       → monthly payload (JSON)
  GET  /api/mis/monthly/:year/:month/html  → printable HTML
  GET  /api/mis/monthly/:year/:month/xlsx  → Excel workbook download
  GET  /api/mis/completeness?from=&to=     → entry-completeness payload (JSON)
  GET  /api/mis/data-range                 → first/last date holding data, per form
  GET  /api/mis/employees              → HR roster (mis.html "HR" tab)
  GET  /api/mis/it-assets              → IT asset register (mis.html "Assets" tab)
  GET  /api/mis/vehicles               → vehicle fleet register (mis.html "Assets" tab)
  (GET /api/mis/compliance-certs was retired 2026-10-12: the Compliance tab now
   reads the live Compliance Master, /api/compliance.)
  POST /api/mis/digest/send           → send the digest now (admin/md;
                                        body {date?} for a specific day)
*/

const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { MIS_VIEW_ROLES } = require('../config/misAccess');
const { validate, z, zDate } = require('../middleware/validate');
const report = require('../services/misReport');
const render = require('../services/misRender');
const excel  = require('../services/misExcel');
const digest = require('../services/digest');

/* Static reference data (HR/IT/vehicle/compliance registers) — previously
   embedded as literal JS in mis.html, readable by anyone who requested the
   page regardless of login. Now served only to authenticated users; kept
   as plain JSON files (not a DB table) since this is hand-maintained
   reference data with no write path yet, not daily operational data. */
const EMPLOYEES      = require('../data/mis/employees.json');
const IT_ASSETS       = require('../data/mis/it-assets.json');
const VEHICLES        = require('../data/mis/vehicles.json');

const router = express.Router();

const zYear  = z.coerce.number().int().min(1990).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);
const dateParams      = z.object({ date: zDate });
const yearMonthParams = z.object({ year: zYear, month: zMonth });

function xlsxHeaders(res, filename) {
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
}

/* ── Data range ───────────────────────────────────────────────
   Which dates actually hold data, per form type, plus the newest kpi_monthly
   period.

   Every analytics page defaults its date picker to *today*, which is right in
   a plant entering reports daily and wrong in every other situation: with the
   current backfill ending 15 Jul 2026, Material & Power Balance, Equipment
   Reliability and Operational Insights all opened completely empty and looked
   broken rather than out of date. Pages now ask this endpoint for the latest
   date that has data and fall back to it, saying so on screen — see
   forms/latest-period.js. One cheap aggregate over indexed columns. */
router.get('/data-range', requireAuth, async (req, res, next) => {
  try {
    const [forms, kpi] = await Promise.all([
      db.query(
        `SELECT form_type, MIN(record_date) AS first, MAX(record_date) AS last, COUNT(*)::int AS days
         FROM daily_reports GROUP BY form_type ORDER BY form_type`
      ),
      db.query(
        `SELECT MIN(year * 100 + month) AS first, MAX(year * 100 + month) AS last
         FROM kpi_monthly`
      ),
    ]);

    const byForm = {};
    for (const r of forms.rows) {
      byForm[r.form_type] = { first: r.first, last: r.last, days: r.days };
    }

    /* The overall latest is what a page with no single form in mind wants. */
    const lastDates = forms.rows.map(r => r.last).filter(Boolean).sort();
    const k = kpi.rows[0] || {};
    const period = n => (n ? { year: Math.floor(n / 100), month: n % 100 } : null);

    res.json({
      forms: byForm,
      overall: { first: forms.rows.map(r => r.first).filter(Boolean).sort()[0] || null,
                 last:  lastDates[lastDates.length - 1] || null },
      kpiMonthly: { first: period(Number(k.first)), last: period(Number(k.last)) },
    });
  } catch (err) { next(err); }
});

// ── Daily ────────────────────────────────────────────────────
router.get('/daily/:date', requireAuth, validate(dateParams, 'params'), async (req, res, next) => {
  try { res.json(await report.gatherDaily(req.validated.params.date)); }
  catch (err) { next(err); }
});

router.get('/daily/:date/html', requireAuth, validate(dateParams, 'params'), async (req, res, next) => {
  try {
    const payload = await report.gatherDaily(req.validated.params.date);
    res.type('html').send(render.renderDailyHtml(payload));
  } catch (err) { next(err); }
});

/* ── Daily Summary Report ─────────────────────────────────────
   The covering "DAILY SUMMARY REPORT dd.mm.yyyy" table the plant head
   reads before the eight workbooks themselves — Mining / Stock /
   Production with ON DATE, MTD and YTD. Rendered at the foot of the
   Executive Summary (index.html).

   Authenticated like the other MIS reads, but NOT read-open: the caller's
   role is passed down and gatherDailySummary() drops the sections that role
   may not see. This report is the first thing to put raw-material stock and
   quarry movements on the Executive Summary, which every role can open, so
   leaving it open would have quietly widened store.rawmat and the Quarry
   department to hr, it, sales, purchase, logistics, cpp, pm, ei and packing.
   Filtered server-side rather than only in the page, so calling the endpoint
   directly gets the same answer. */
router.get('/daily-summary/:date', requireAuth, validate(dateParams, 'params'), async (req, res, next) => {
  try { res.json(await report.gatherDailySummary(req.validated.params.date, req.user.role)); }
  catch (err) { next(err); }
});

router.get('/daily/:date/xlsx', requireAuth, validate(dateParams, 'params'), async (req, res, next) => {
  try {
    const { date } = req.validated.params;
    const buf = await excel.dailyWorkbook(await report.gatherDaily(date));
    xlsxHeaders(res, `Nyati-MIS-Daily-${date}.xlsx`);
    res.send(buf);
  } catch (err) { next(err); }
});

// ── Completeness (entry-reliability heatmap) ────────────────────
router.get('/completeness', requireAuth, validate(z.object({ from: zDate, to: zDate }), 'query'), async (req, res, next) => {
  try {
    const { from, to } = req.validated.query;
    res.json(await report.gatherCompleteness(from, to));
  } catch (err) { next(err); }
});

// ── Monthly ──────────────────────────────────────────────────
router.get('/monthly/:year/:month', requireAuth, validate(yearMonthParams, 'params'), async (req, res, next) => {
  try {
    const { year, month } = req.validated.params;
    res.json(await report.gatherMonthly(year, month));
  } catch (err) { next(err); }
});

router.get('/monthly/:year/:month/html', requireAuth, validate(yearMonthParams, 'params'), async (req, res, next) => {
  try {
    const { year, month } = req.validated.params;
    res.type('html').send(render.renderMonthlyHtml(await report.gatherMonthly(year, month)));
  } catch (err) { next(err); }
});

router.get('/monthly/:year/:month/xlsx', requireAuth, validate(yearMonthParams, 'params'), async (req, res, next) => {
  try {
    const { year, month } = req.validated.params;
    const buf = await excel.monthlyWorkbook(await report.gatherMonthly(year, month));
    xlsxHeaders(res, `Nyati-MIS-Monthly-${year}-${String(month).padStart(2, '0')}.xlsx`);
    res.send(buf);
  } catch (err) { next(err); }
});

/* ── Reference data (HR / IT / vehicles / compliance) ────────────
   The MIS Dashboard's own payload, and management-only as of 2026-09-03.
   These were `requireAuth` alone, so any authenticated user could read the
   whole company's HR strength, asset register and compliance certificates
   straight from the API — the mis_tabs check that was supposed to stop
   them lived only in the browser. A hidden tab is not a permission. */
const misOnly = requireRole(...MIS_VIEW_ROLES);
router.get('/employees',        requireAuth, misOnly, (req, res) => { res.json(EMPLOYEES); });
router.get('/it-assets',        requireAuth, misOnly, (req, res) => { res.json(IT_ASSETS); });
router.get('/vehicles',         requireAuth, misOnly, (req, res) => { res.json(VEHICLES); });

// ── Digest ───────────────────────────────────────────────────
router.post('/digest/send',
  requireAuth, requireRole('admin', 'md'),
  validate(z.object({ date: zDate.optional() }), 'body'),
  async (req, res, next) => {
    try { res.json(await digest.sendDigest(req.validated.body.date)); }
    catch (err) { next(err); }
  });

module.exports = router;
