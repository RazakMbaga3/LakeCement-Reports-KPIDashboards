/*
  routes/reports.js — Daily Form Submit & Retrieve

  All daily forms use the same endpoints; "form_type" differentiates them.

  POST /api/reports/:formType                  → submit/update a daily form
                                                 (body.status 'draft'|'submitted';
                                                  body.replace to overwrite rather
                                                  than merge the stored fields)
  POST /api/reports/:formType/:date/approve    → HOD approves a pending report
  POST /api/reports/:formType/:date/reject     → HOD rejects a pending report
  GET  /api/reports/:formType/:date            → get one day's data
  GET  /api/reports/:formType?from=&to=        → get a date range (for monthly/YTD views)

  Every request is validated (middleware/validate.js) before it touches SQL;
  handlers read the parsed values from req.validated.

  APPROVAL WORKFLOW: an Officer/Senior submission always lands as
  'pending_approval' — even overwriting a previously-approved record, since
  any edit needs fresh sign-off. A HOD (or admin/md) submission is
  self-certifying and lands as 'approved' directly, matching today's
  one-account-per-department reality (no second reviewer for an HOD's own
  entries — an accepted trade-off, not a bug).
*/

const express = require('express');
const db      = require('../db');
const { requireAuth }       = require('../middleware/auth');
const { requireFormAccess } = require('../middleware/formAccess');
const { requireApprover }   = require('../middleware/approval');
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
  /* What the caller INTENDS this write to be. A draft is work in progress:
     it must not enter an approval queue, must not be self-certified as
     approved, and must not be read as a finished report by the KPI engine
     or the MIS pack. Defaults to 'submitted' so an older client that
     doesn't send it keeps its current behaviour. */
  status:  z.enum(['draft', 'submitted']).default('submitted'),
  /* Replace the stored JSONB wholesale instead of merging into it. Only
     for callers that own the entire row (importers, the Odoo sync). See
     the merge note on the handler below. */
  replace: z.boolean().default(false),
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
// Submit or update a daily form.
// The browser sends: { date, shift, data: { field: value, … }, status?, replace? }
router.post('/:formType',
  requireAuth, requireFormAccess,
  validate(formTypeParams, 'params'), validate(submitBody, 'body'),
  async (req, res, next) => {
    try {
      const { formType } = req.validated.params;
      const { date, shift, data, replace } = req.validated.body;
      const intent = req.validated.body.status;   // 'draft' | 'submitted'

      const factError = findFactTypeError(formType, data);
      if (factError) return res.status(400).json({ error: factError });

      /* A DRAFT is not a submission. Both used to come through here with no
         way to tell them apart, so the status was derived from the caller's
         level alone: an HOD pressing "Save Draft" stored a half-filled form
         as `approved` (feeding the KPIs and the MIS pack as a finished
         report), and an Officer's draft landed in their HOD's approval queue
         looking like completed work. `status:'draft'` now says which it is;
         the approval rules below apply only to a real submission. */
      const isDraft = intent === 'draft';
      // HOD/admin/md submissions are self-certifying (approved on save);
      // Officer/Senior submissions always need their HOD's sign-off.
      const selfApproves = req.user.role === 'admin' || req.user.role === 'md' || req.user.level === 'hod';
      const status     = isDraft ? 'draft' : (selfApproves ? 'approved' : 'pending_approval');
      const approvedBy = (!isDraft && selfApproves) ? req.user.id : null;
      const approvedAt = (!isDraft && selfApproves) ? new Date() : null;

      /* MERGE by default; full replace only when the caller says so.
         `data = EXCLUDED.data` used to overwrite the whole JSONB blob, so
         any client that posted a partial payload silently destroyed every
         field it didn't know about. That is not hypothetical:
         power-plant-report.html is a read-only report page — 22 CPP metrics
         rendered from stored data, but only `date` and `prepared_by` bound
         to inputs — wired to a Submit button, so one click would have
         replaced that day's entire CPP record with two fields and broken
         cpp-heat-rate / cpp-auxiliary-power for that day.

         Merging is safe for forms because a form always posts every field it
         owns, blank ones included (form-persist.js's _collect reads every
         input's value, so an emptied field arrives as ""), and a value can
         still be cleared that way. `replace: true` stays available for
         callers that genuinely own the whole row — an importer or a sync
         job rebuilding a day from an external source. */
      const merge = replace !== true;

      // Upsert + its audit_log row in one transaction — a report the
      // client sees as "saved" must never have a silently-missing entry
      // in the compliance trail because the audit insert alone hit a
      // transient error after the data write already committed.
      const record = await db.withTransaction(async (client) => {
        const result = await client.query(`
          INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status, approved_by, approved_at)
          VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
          ON CONFLICT (form_type, record_date, shift)
          DO UPDATE SET
            data        = CASE WHEN $9 THEN daily_reports.data || EXCLUDED.data ELSE EXCLUDED.data END,
            updated_by  = $5,
            updated_at  = NOW(),
            status      = EXCLUDED.status,
            approved_by = EXCLUDED.approved_by,
            approved_at = EXCLUDED.approved_at,
            rejected_by = NULL,
            rejected_at = NULL,
            rejection_reason = NULL
          RETURNING *
        `, [formType, date, shift, JSON.stringify(data), req.user.id, status, approvedBy, approvedAt, merge]);

        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.user.id, req.user.username, isDraft ? 'FORM_DRAFT' : 'FORM_SUBMIT', formType, date,
           `${Object.keys(data).length} field(s), ${merge ? 'merged' : 'replaced'} → status ${status}`, req.ip]
        );

        return result.rows[0];
      });
      if (!isDraft) formSubmissions.inc({ form_type: formType });

      res.json({ success: true, record });
    } catch (err) { next(err); }
  });

// ── POST /api/reports/:formType/:date/approve ─────────────────
// HOD (or admin/md) approves a pending_approval report.
router.post('/:formType/:date/approve',
  requireAuth, requireApprover,
  validate(formDateParams, 'params'),
  validate(z.object({ shift: zShift.default('day') }), 'body'),
  async (req, res, next) => {
    try {
      const { formType, date } = req.validated.params;
      const { shift }          = req.validated.body;

      const record = await db.withTransaction(async (client) => {
        const result = await client.query(`
          UPDATE daily_reports SET
            status = 'approved', approved_by = $4, approved_at = NOW(),
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
          WHERE form_type = $1 AND record_date = $2 AND shift = $3 AND status = 'pending_approval'
          RETURNING *
        `, [formType, date, shift, req.user.id]);

        if (!result.rows[0]) return null;

        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, record_date, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.user.id, req.user.username, 'FORM_APPROVE', formType, date, req.ip]
        );

        return result.rows[0];
      });

      if (!record) return res.status(409).json({ error: 'No pending_approval report found for this form/date/shift.' });
      res.json({ success: true, record });
    } catch (err) { next(err); }
  });

// ── POST /api/reports/:formType/:date/reject ──────────────────
// HOD (or admin/md) rejects a pending_approval report, with a reason.
const rejectBody = z.object({
  shift:  zShift.default('day'),
  reason: z.string().trim().min(1).max(500),
});
router.post('/:formType/:date/reject',
  requireAuth, requireApprover,
  validate(formDateParams, 'params'), validate(rejectBody, 'body'),
  async (req, res, next) => {
    try {
      const { formType, date }  = req.validated.params;
      const { shift, reason }   = req.validated.body;

      const record = await db.withTransaction(async (client) => {
        const result = await client.query(`
          UPDATE daily_reports SET
            status = 'rejected', rejected_by = $4, rejected_at = NOW(), rejection_reason = $5,
            approved_by = NULL, approved_at = NULL
          WHERE form_type = $1 AND record_date = $2 AND shift = $3 AND status = 'pending_approval'
          RETURNING *
        `, [formType, date, shift, req.user.id, reason]);

        if (!result.rows[0]) return null;

        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.user.id, req.user.username, 'FORM_REJECT', formType, date, reason, req.ip]
        );

        return result.rows[0];
      });

      if (!record) return res.status(409).json({ error: 'No pending_approval report found for this form/date/shift.' });
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
