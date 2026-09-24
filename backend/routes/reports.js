/*
  routes/reports.js — Daily Form Submit & Retrieve

  All daily forms use the same endpoints; "form_type" differentiates them.

  POST /api/reports/:formType                  → submit/update a daily form
                                                 (body.status 'draft'|'submitted';
                                                  body.replace to overwrite rather
                                                  than merge the stored fields;
                                                  body.autosave for the form's
                                                  unattended background save)
  GET  /api/reports/unfinished                 → my drafts + rejected reports, all my forms
  POST /api/reports/:formType/:date/approve    → HOD approves a pending report
  POST /api/reports/:formType/:date/reject     → HOD rejects a pending report
  GET  /api/reports/:formType/history          → which days have a record (date + status only)
  GET  /api/reports/:formType/:date            → get one day's data
  GET  /api/reports/:formType?from=&to=        → get a date range (for monthly/YTD views)

  Every request is validated (middleware/validate.js) before it touches SQL;
  handlers read the parsed values from req.validated.

  APPROVAL WORKFLOW: an Officer/Senior submission lands as
  'pending_approval'; a HOD (or admin/md) submission is self-certifying and
  lands as 'approved' directly, matching today's one-account-per-department
  reality (no second reviewer for an HOD's own entries — an accepted
  trade-off, not a bug).

  ONCE REPORTED, LOCKED: a report already 'approved' or 'pending_approval'
  can no longer be overwritten by a plain re-submit — that now 409s with
  code 'REPORT_LOCKED'. It used to merge silently and reset the row to
  'pending_approval', erasing approved_by/approved_at with no record that
  they had ever been set. The only way through today is an admin/md
  break-glass with a written `amendReason` (audited as FORM_AMEND_DIRECT);
  a granted correction window is WS-A2's job. See THE LOCK in the handler.

  EVERY CHANGE KEEPS ITS PRE-IMAGE: submit, approve and reject each write a
  report_revisions row inside the same transaction as the change itself —
  what the report said before, who changed it and why (services/
  reportRevisions.js). Background autosaves do not, by construction: that
  branch returns before the transaction block ever starts.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth }       = require('../middleware/auth');
const { requireFormAccess } = require('../middleware/formAccess');
const { requireApprover, OWNING_ROLE_BY_FORM_TYPE } = require('../middleware/approval');
const { validate, z, zDate, zShift, zNumeric } = require('../middleware/validate');
const { formSubmissions } = require('../services/metrics');
const { shouldSnapshot, changedFields, recordRevision } = require('../services/reportRevisions');
const { FACTS } = require('../../forms/formula-registry.js');

const router = express.Router();

const { VALID_FORMS } = require('../config/forms');
const { ROLE_FORM_ACCESS } = require('../config/formAccess');

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
  /* An UNATTENDED save: the form's own background autosave, not a person
     pressing Save Draft. It keeps a half-typed report safe on the server
     without deciding anything on the author's behalf — see the autosave
     branch of the handler for exactly what that rules out. */
  autosave: z.boolean().default(false),
  /* BREAK GLASS. A written reason for overwriting a report that has already
     been reported (approved / pending_approval), which is otherwise refused
     outright — see the REPORT_LOCKED check in the handler. Only admin/md may
     use it, it is never offered by any UI, and it is what turns an importer
     re-run from a silent overwrite into an audited amendment. The 10-char
     floor is deliberate: "fix" is not a reason. */
  amendReason: z.string().trim().min(10).max(500).optional(),
}).refine(b => !b.autosave || (b.status === 'draft' && !b.replace),
  'an autosave must be a draft and cannot replace the record');

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
      const { date, shift, data, replace, autosave, amendReason } = req.validated.body;
      const intent = req.validated.body.status;   // 'draft' | 'submitted'

      const factError = findFactTypeError(formType, data);
      if (factError) return res.status(400).json({ error: factError });

      /* AUTOSAVE — only ever merges typed values into a report that is
         still the author's to edit. Three things a background write must
         never do, all of which an explicit Save Draft may:
           • touch a report that has been SUBMITTED or APPROVED. A stale tab
             left open overnight would otherwise flip a signed-off report back
             to 'draft' and merge yesterday's figures into it. → 409.
           • change the status of a REJECTED report. The author is mid-fix
             and the HOD's reason must survive until they resubmit; only a
             deliberate Save Draft or Submit may move it.
           • write an audit_log row. The trail records what people decided,
             not a heartbeat every twenty seconds.
         A day with no report yet is created as a plain 'draft'. */
      if (autosave) {
        /* One atomic statement, so two tabs autosaving the same new day
           cannot both INSERT, and a submit landing between "look" and
           "write" cannot be overwritten: the DO UPDATE's WHERE refuses a
           locked row and RETURNING then yields nothing. `status` and the
           rejection columns are deliberately absent from the SET. */
        const result = await db.query(`
          INSERT INTO daily_reports (form_type, record_date, shift, data, submitted_by, submitted_at, status)
          VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), 'draft')
          ON CONFLICT (form_type, record_date, shift)
          DO UPDATE SET data = daily_reports.data || EXCLUDED.data,
                        updated_by = $5, updated_at = NOW()
          WHERE daily_reports.status NOT IN ('pending_approval', 'approved')
          RETURNING *
        `, [formType, date, shift, JSON.stringify(data), req.user.id]);

        if (!result.rows[0]) {
          const cur = await db.query(
            'SELECT status FROM daily_reports WHERE form_type = $1 AND record_date = $2 AND shift = $3',
            [formType, date, shift]);
          const locked = cur.rows[0] ? cur.rows[0].status : 'submitted';
          return res.status(409).json({
            error: `This report was already submitted (${locked}) — reload the page to see it.`,
            status: locked,
          });
        }
        return res.json({ success: true, record: result.rows[0] });
      }

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

      // Upsert + its revision + its audit_log row in one transaction — a
      // report the client sees as "saved" must never have a silently-missing
      // entry in the compliance trail because the audit insert alone hit a
      // transient error after the data write already committed.
      const outcome = await db.withTransaction(async (client) => {
        /* The PRE-IMAGE, under a row lock, BEFORE anything is written.
           Two jobs in one statement:
             • it is the only chance to read what this write is about to
               destroy — after the upsert's merge the old figures are gone
               from the database entirely (see services/reportRevisions.js);
             • FOR UPDATE serialises overlapping submits for the same day.
               Today they serialise on ON CONFLICT instead, which is enough
               to keep the table consistent but leaves neither writer able to
               see what it replaced — so the second one's revision would
               record a pre-image the first had already overwritten.
           services/odooProductionAutofill.js:111-113 takes the same lock for
           the same reason. */
        const priorResult = await client.query(`
          SELECT data, status, approved_by, approved_at
          FROM daily_reports
          WHERE form_type = $1 AND record_date = $2 AND shift = $3
          FOR UPDATE
        `, [formType, date, shift]);
        const prior = priorResult.rows[0] || null;

        /* ── THE LOCK ────────────────────────────────────────────────────
           A report that has been REPORTED — signed off, or sitting in an
           HOD's queue — is not the author's to silently rewrite. Until now
           re-POSTing it merged new values over the old ones, reset it to
           'pending_approval' and cleared approved_by/approved_at: an
           approval could be erased by anyone with submit rights and nothing
           anywhere recorded that it had ever existed. The only thing
           stopping it was that no screen offered the button.

           There are meant to be exactly THREE ways past this, and each one
           leaves a trace:
             1. A granted correction window — an HOD/admin opens a
                time-boxed amendment for a specific day, the author fixes it,
                it re-enters approval. NOT BUILT YET: migration 025 / WS-A2
                adds the report_amendments table and this becomes one more
                `|| grantedAmendment` below, nothing else in this handler.
             2. admin/md break-glass, with a written reason. Audited as
                FORM_AMEND_DIRECT, never offered in any UI, and how a
                re-import becomes an amendment instead of an overwrite
                (see scripts/import-cpp.js).
             3. The Odoo autofill, which does not come through this route at
                all — it writes daily_reports directly and deliberately, and
                is therefore not subject to this lock (decision A in
                services/odooProductionAutofill.js). It logs its own
                ODOO_AUTOFILL revision.

           Intent 'draft' is locked too. An explicit Save Draft over an
           approved report would otherwise reset status to 'draft' and
           un-approve it — the same silent overwrite by another name, and
           the easier one to reach because it carries no amendReason field
           at all. Autosave is already refused by its own WHERE clause
           further up; this is the explicit-save twin of that rule. */
        const lockedStatus =
          prior && (prior.status === 'approved' || prior.status === 'pending_approval')
            ? prior.status : null;

        /* Who may overwrite a reported report, with a written reason.
           Deliberately the SAME predicate as requireApprover(): admin/md,
           or the HOD of the role that owns this form type. Restricting it
           to admin/md alone made the path unreachable for the callers that
           need it — requireFormAccess runs first and refuses an MD
           submitting a production report, and every import service account
           is a department-role HOD (import-cpp is role 'cpp'), not an
           admin. So the break-glass existed but nothing could reach it, and
           re-running scripts/import-cpp.js over approved days would fail.

           This is not an escalation: an owning HOD can already approve
           anything on this form type and self-certifies their own
           submissions. What changes is that the overwrite now costs a
           written reason, a report_revisions pre-image and an audit row —
           where before, ANY user with submit access could overwrite an
           approved report silently and leave nothing behind. */
        const isApprover =
          req.user.role === 'admin' ||
          req.user.role === 'md' ||
          (req.user.level === 'hod' && req.user.role === OWNING_ROLE_BY_FORM_TYPE[formType]);
        const breakGlass = isApprover && !!amendReason;
        const mayOverwriteReported = breakGlass;   // WS-A2: `|| grantedAmendment`

        if (lockedStatus && !mayOverwriteReported) {
          return { locked: lockedStatus };
        }
        const isAmendment = !!lockedStatus;

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

        const record = result.rows[0];
        const action = isAmendment ? 'FORM_AMEND_DIRECT' : (isDraft ? 'FORM_DRAFT' : 'FORM_SUBMIT');

        /* The revision — the pre-image this write just replaced. Skipped
           only for draft-over-draft (shouldSnapshot), so filling a form in
           over an afternoon writes one revision rather than one per Save.
           `record.data` is the real post-image straight back from the
           upsert, so changed_fields reflects what the merge actually did
           instead of this route re-deriving JSONB `||` semantics in JS.

           The form's UNATTENDED autosave never gets here: its branch
           returns above, before this transaction exists. That is the
           structural reason background saves cannot bloat this table, and
           test/report-revisions.test.js asserts the ordering holds. */
        if (shouldSnapshot(prior, { status })) {
          await recordRevision(client, {
            formType, recordDate: date, shift, action,
            priorData:        prior ? prior.data : null,
            priorStatus:      prior ? prior.status : null,
            priorApprovedBy:  prior ? prior.approved_by : null,
            priorApprovedAt:  prior ? prior.approved_at : null,
            changedFields:    changedFields(prior ? prior.data : null, record.data),
            actorId:          req.user.id,
            actorName:        req.user.name || req.user.username,
            reason:           isAmendment ? amendReason : null,
            ipAddress:        req.ip,
          });
        }

        await client.query(
          'INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [req.user.id, req.user.username, action, formType, date,
           `${Object.keys(data).length} field(s), ${merge ? 'merged' : 'replaced'} → status ${status}`
             + (isAmendment ? ` — AMENDED a ${lockedStatus} report: ${amendReason}` : ''), req.ip]
        );

        return { record };
      });

      /* 409, not 403: the request was legitimate, the report's current state
         is what refuses it. `code` is machine-readable so a client can tell
         this apart from the autosave conflict above, which has no code. */
      if (outcome.locked) {
        return res.status(409).json({
          error: `This report is ${outcome.locked} and can no longer be overwritten. `
               + 'Ask an approver to reopen it for correction.',
          code:   'REPORT_LOCKED',
          status: outcome.locked,
        });
      }

      if (!isDraft) formSubmissions.inc({ form_type: formType });

      res.json({ success: true, record: outcome.record });
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
        // Pre-image under the row lock, before the UPDATE — same reasoning
        // as the submit path. An approval is a signature: the trail has to
        // say what state was signed, not just that somebody signed.
        const priorResult = await client.query(`
          SELECT status, approved_by, approved_at FROM daily_reports
          WHERE form_type = $1 AND record_date = $2 AND shift = $3
          FOR UPDATE
        `, [formType, date, shift]);
        const prior = priorResult.rows[0] || null;

        const result = await client.query(`
          UPDATE daily_reports SET
            status = 'approved', approved_by = $4, approved_at = NOW(),
            rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
          WHERE form_type = $1 AND record_date = $2 AND shift = $3 AND status = 'pending_approval'
          RETURNING *
        `, [formType, date, shift, req.user.id]);

        if (!result.rows[0]) return null;

        /* Unconditional, no shouldSnapshot(): the UPDATE above only matches
           'pending_approval', which is a REPORTED status changing to
           'approved' — the rule would return true every time.
           prior_data is NULL because approving moves only the status
           columns; `data` is untouched, and null there reads as
           "unchanged", not "unknown". */
        await recordRevision(client, {
          formType, recordDate: date, shift, action: 'FORM_APPROVE',
          priorData:       null,
          priorStatus:     prior ? prior.status : null,
          priorApprovedBy: prior ? prior.approved_by : null,
          priorApprovedAt: prior ? prior.approved_at : null,
          actorId:         req.user.id,
          actorName:       req.user.name || req.user.username,
          ipAddress:       req.ip,
        });

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
        // Pre-image under the row lock, before the UPDATE — see approve.
        const priorResult = await client.query(`
          SELECT status, approved_by, approved_at FROM daily_reports
          WHERE form_type = $1 AND record_date = $2 AND shift = $3
          FOR UPDATE
        `, [formType, date, shift]);
        const prior = priorResult.rows[0] || null;

        const result = await client.query(`
          UPDATE daily_reports SET
            status = 'rejected', rejected_by = $4, rejected_at = NOW(), rejection_reason = $5,
            approved_by = NULL, approved_at = NULL
          WHERE form_type = $1 AND record_date = $2 AND shift = $3 AND status = 'pending_approval'
          RETURNING *
        `, [formType, date, shift, req.user.id, reason]);

        if (!result.rows[0]) return null;

        // Unconditional for the same reason as approve. `data` is untouched,
        // so prior_data stays NULL; the HOD's reason is the payload here.
        await recordRevision(client, {
          formType, recordDate: date, shift, action: 'FORM_REJECT',
          priorData:       null,
          priorStatus:     prior ? prior.status : null,
          priorApprovedBy: prior ? prior.approved_by : null,
          priorApprovedAt: prior ? prior.approved_at : null,
          actorId:         req.user.id,
          actorName:       req.user.name || req.user.username,
          reason,
          ipAddress:       req.ip,
        });

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

// ── GET /api/reports/unfinished ─────────────────────────────
// The caller's own unfinished work: every draft, and every report an HOD
// rejected, on any form this role may submit, over the last `days` days —
// newest first. It is what lets the forms and the sidebar say "you have a
// draft for 19 Sept" instead of waiting for someone to go looking through
// Load Previous. Only forms the role can SUBMIT are listed (a reader has
// nothing to finish), and only dates and statuses leave — never field data.
// Must stay registered before /:formType, which would take "unfinished" for
// a form type and 400.
router.get('/unfinished',
  requireAuth,
  validate(z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }), 'query'),
  async (req, res, next) => {
    try {
      const forms = ROLE_FORM_ACCESS[req.user.role] || [];
      if (!forms.length) return res.json([]);

      const result = await db.query(`
        SELECT form_type, record_date, status, updated_at, submitted_at, rejection_reason
        FROM daily_reports
        WHERE form_type = ANY($1) AND shift = 'day'
          AND status IN ('draft', 'rejected')
          AND record_date >= CURRENT_DATE - $2::int
        ORDER BY record_date DESC, form_type
        LIMIT 100
      `, [forms, req.validated.query.days]);

      res.json(result.rows);
    } catch (err) { next(err); }
  });

// ── GET /api/reports/:formType/history ──────────────────────
// Which days have a saved record for this form, newest first: date, status
// and who/when last touched it — never the field data.
//
// This is what "Load Previous" lists. It used to list only what THIS
// BROWSER had in localStorage, so a draft saved from another PC, a phone, a
// cleared browser or the other address of the app (http vs https, IP vs
// domain) read "No drafts saved yet" while sitting on the server the whole
// time. Must stay registered before /:formType/:date below, which would
// otherwise take "history" for a malformed date and 400.
router.get('/:formType/history',
  requireAuth,
  validate(formTypeParams, 'params'),
  validate(z.object({
    shift: zShift.default('day'),
    limit: z.coerce.number().int().min(1).max(365).default(120),
  }), 'query'),
  async (req, res, next) => {
    try {
      const { formType }     = req.validated.params;
      const { shift, limit } = req.validated.query;

      const result = await db.query(`
        SELECT r.record_date, r.shift, r.status, r.submitted_at, r.updated_at,
               r.rejection_reason, u.full_name AS saved_by_name
        FROM daily_reports r
        LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.submitted_by)
        WHERE r.form_type = $1 AND r.shift = $2
        ORDER BY r.record_date DESC
        LIMIT $3
      `, [formType, shift, limit]);

      res.json(result.rows);
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
