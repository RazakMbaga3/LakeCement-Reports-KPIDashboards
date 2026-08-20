/*
  routes/reports.js — Daily Form Submit & Retrieve

  All daily forms use the same endpoints; "form_type" differentiates them.

  POST /api/reports/:formType           → submit/update a daily form
  GET  /api/reports/:formType/:date     → get one day's data
  GET  /api/reports/:formType?from=&to= → get a date range (for monthly/YTD views)

  Every request is validated (middleware/validate.js) before it touches SQL;
  handlers read the parsed values from req.validated.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth }       = require('../middleware/auth');
const { requireFormAccess } = require('../middleware/formAccess');
const { validate, z, zDate, zShift, zNumeric } = require('../middleware/validate');
const { formSubmissions } = require('../services/metrics');
const { FACTS } = require('../../forms/formula-registry.js');

const router = express.Router();

const { VALID_FORMS } = require('../config/forms');

const formTypeParams = z.object({ formType: z.enum(VALID_FORMS) });
const formDateParams = formTypeParams.extend({ date: zDate });

const submitBody = z.object({
  date:  zDate,
  shift: zShift.default('day'),
  data:  z.record(z.string(), z.unknown())
           .refine(o => Object.keys(o).length > 0, 'must not be empty'),
});

/* Every fact in forms/formula-registry.js declares exactly which form
   field it reads and is always a numeric measurement (verified: every
   FACTS unit is %, MT, kWh, min, etc. — never text). `data` itself stays
   an open object (z.record) because a form can carry fields no formula
   reads yet (remarks, free text) — this only type-checks the subset of
   keys the formula engine will actually consume, so a typo'd/garbled
   value for a real KPI input is rejected instead of silently becoming
   `null` ("not yet reported") downstream in formulaEngine.js. */
const FACT_FIELDS_BY_FORM = {};
Object.values(FACTS).forEach(f => {
  (FACT_FIELDS_BY_FORM[f.form] || (FACT_FIELDS_BY_FORM[f.form] = new Set())).add(f.field);
});

function findFactTypeError(formType, data) {
  const fields = FACT_FIELDS_BY_FORM[formType];
  if (!fields) return null;
  for (const key of Object.keys(data)) {
    if (!fields.has(key)) continue;
    if (!zNumeric.safeParse(data[key]).success) {
      return `Field "${key}" must be a number (or blank) — got ${JSON.stringify(data[key])}`;
    }
  }
  return null;
}

// ── POST /api/reports/:formType ──────────────────────────────
// Submit or update a daily form
// The browser sends: { date: "2026-06-08", shift: "day", data: { field1: val, ... } }
router.post('/:formType',
  requireAuth, requireFormAccess,
  validate(formTypeParams, 'params'), validate(submitBody, 'body'),
  async (req, res, next) => {
    try {
      const { formType }          = req.validated.params;
      const { date, shift, data } = req.validated.body;

      const factError = findFactTypeError(formType, data);
      if (factError) return res.status(400).json({ error: factError });

      // Upsert + its audit_log row in one transaction — a report the
      // client sees as "saved" must never have a silently-missing entry
      // in the compliance trail because the audit insert alone hit a
      // transient error after the data write already committed.
      const record = await db.withTransaction(async (client) => {
        const result = await client.query(`
          INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (form_type, record_date, shift)
          DO UPDATE SET
            data       = EXCLUDED.data,
            updated_by = $5,
            updated_at = NOW()
          RETURNING *
        `, [formType, date, shift, JSON.stringify(data), req.user.id]);

        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, record_date, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.user.id, req.user.username, 'FORM_SUBMIT', formType, date, req.ip]
        );

        return result.rows[0];
      });
      formSubmissions.inc({ form_type: formType });

      res.json({ success: true, record });
    } catch (err) { next(err); }
  });

// ── GET /api/reports/:formType/:date ────────────────────────
// Get one specific day's data for a form
// e.g. GET /api/reports/production/2026-06-08
router.get('/:formType/:date',
  requireAuth,
  validate(formDateParams, 'params'),
  validate(z.object({ shift: zShift.default('day') }), 'query'),
  async (req, res, next) => {
    try {
      const { formType, date } = req.validated.params;
      const { shift }          = req.validated.query;

      const result = await db.query(
        'SELECT * FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3',
        [formType, date, shift]
      );

      // Return the record if found, or null (form not yet filled for this day)
      res.json(result.rows[0] || null);
    } catch (err) { next(err); }
  });

// ── GET /api/reports/:formType?from=2026-06-01&to=2026-06-30 ─
// Get all records for a form in a date range (used for monthly/YTD views)
router.get('/:formType',
  requireAuth,
  validate(formTypeParams, 'params'),
  validate(z.object({ from: zDate, to: zDate, shift: zShift.optional() }), 'query'),
  async (req, res, next) => {
    try {
      const { formType }        = req.validated.params;
      const { from, to, shift } = req.validated.query;

      let query = `
        SELECT r.*, u.full_name as submitted_by_name
        FROM daily_reports r
        LEFT JOIN users u ON r.submitted_by = u.id
        WHERE r.form_type = $1 AND r.record_date BETWEEN $2 AND $3
      `;
      const params = [formType, from, to];

      if (shift) {
        query += ` AND r.shift = $4`;
        params.push(shift);
      }

      query += ` ORDER BY r.record_date ASC`;

      const result = await db.query(query, params);
      res.json(result.rows);
    } catch (err) { next(err); }
  });

module.exports = router;
