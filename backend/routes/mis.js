/*
  routes/mis.js — server-rendered MIS reports & distribution

  GET  /api/mis/daily/:date            → daily report payload (JSON)
  GET  /api/mis/daily/:date/html      → printable HTML (browser print → PDF)
  GET  /api/mis/daily/:date/xlsx      → Excel workbook download
  GET  /api/mis/monthly/:year/:month       → monthly payload (JSON)
  GET  /api/mis/monthly/:year/:month/html  → printable HTML
  GET  /api/mis/monthly/:year/:month/xlsx  → Excel workbook download
  GET  /api/mis/completeness?from=&to=     → entry-completeness payload (JSON)
  POST /api/mis/digest/send           → send the digest now (admin/md;
                                        body {date?} for a specific day)
*/

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z, zDate } = require('../middleware/validate');
const report = require('../services/misReport');
const render = require('../services/misRender');
const excel  = require('../services/misExcel');
const digest = require('../services/digest');

const router = express.Router();

const zYear  = z.coerce.number().int().min(1990).max(2100);
const zMonth = z.coerce.number().int().min(1).max(12);
const dateParams      = z.object({ date: zDate });
const yearMonthParams = z.object({ year: zYear, month: zMonth });

function xlsxHeaders(res, filename) {
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
}

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

// ── Digest ───────────────────────────────────────────────────
router.post('/digest/send',
  requireAuth, requireRole('admin', 'md'),
  validate(z.object({ date: zDate.optional() }), 'body'),
  async (req, res, next) => {
    try { res.json(await digest.sendDigest(req.validated.body.date)); }
    catch (err) { next(err); }
  });

module.exports = router;
