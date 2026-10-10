/*
  routes/amendments.js — correction requests for reports that have already
  been reported. The rules live in services/reportAmendments.js; this file is
  the HTTP surface. The reasoning behind the whole feature is in
  db/migrations/027_report_amendments.sql.

  GET  /api/amendments                                  → my requests / the requests I decide
  GET  /api/amendments/days/:formType?from=&to=         → every reported day in a range, with
                                                          its sign-off and its correction state
                                                          (corrections.html's day picker)
  POST /api/amendments/:formType/:date                  → ask for a correction
  GET  /api/amendments/:formType/:date                  → that day's requests + its revision trail
  POST /api/amendments/:formType/:date/:id/grant        → open a time-boxed window   (approver)
  POST /api/amendments/:formType/:date/:id/decline      → refuse, with a reason      (approver)
  POST /api/amendments/:formType/:date/:id/withdraw     → take back an undecided ask (requester)

  A separate router rather than routes on reports.js, for the reason
  routes/approvals.js gives: reports.js's GET /:formType catch-all swallows any
  single-segment path registered after it.

  WHO MAY DO WHAT
    request   anyone who may SUBMIT this form type (requireFormAccess) — a
              logistics officer cannot ask for a correction to the quality report
    grant /
    decline   the HOD who owns this form type, or admin/md (requireApprover),
              and never the person who asked, admin/md excepted — the lock is
              advisory otherwise
    withdraw  the requester, or admin/md

  Every state change writes an audit_log row, and a grant additionally
  snapshots the report into report_revisions as the restore point.
*/

const express = require('express');
const db      = require('../db');
const { requireAuth }       = require('../middleware/auth');
const { requireFormAccess } = require('../middleware/formAccess');
const { requireApprover, OWNING_ROLE_BY_FORM_TYPE } = require('../middleware/approval');
const { validate, z, zDate, zShift } = require('../middleware/validate');
const { recordRevision } = require('../services/reportRevisions');
const { FORM_LABELS, prettifyField } = require('../services/misReport');
const { VALID_FORMS } = require('../config/forms');
const { ROLE_FORM_ACCESS } = require('../config/formAccess');
const A = require('../services/reportAmendments');

const router = express.Router();

const formDateParams = z.object({ formType: z.enum(VALID_FORMS), date: zDate });
const amendParams    = formDateParams.extend({ id: z.coerce.number().int().positive() });
const shiftQuery     = z.object({ shift: zShift.default('day') });

const requestBody = z.object({
  shift:  zShift.default('day'),
  /* "fix" is not a reason, and this is what an approver reads to decide. */
  reason: z.string().trim()
            .min(A.MIN_REASON_CHARS, `Say what is wrong in at least ${A.MIN_REASON_CHARS} characters`)
            .max(500),
  /* Optional: which figures the requester says are wrong. Free labels, not
     validated against the form — the reason is the substance. */
  fields: z.array(z.string().trim().min(1).max(60)).max(80).default([]),
});
const grantBody = z.object({
  hours: z.coerce.number().int().min(1).max(A.MAX_WINDOW_HOURS).default(A.DEFAULT_WINDOW_HOURS),
  note:  z.string().trim().max(500).optional(),
});
const declineBody = z.object({
  /* Mandatory, like a rejection: the requester is owed an answer. */
  note: z.string().trim().min(A.MIN_REASON_CHARS, `Say why in at least ${A.MIN_REASON_CHARS} characters`).max(500),
});
const listQuery = z.object({
  state: z.enum(['open', 'all']).default('open'),
  days:  z.coerce.number().int().min(1).max(365).default(30),
});
const daysParams = z.object({ formType: z.enum(VALID_FORMS) });
const daysQuery  = z.object({ from: zDate, to: zDate, shift: zShift.default('day') })
  .refine(q => q.from <= q.to, 'from must not be after to')
  /* A month is what the page asks for; a quarter is the most anyone needs to
     scan for a run of bad days. Unbounded, this is a table scan of history. */
  .refine(q => (Date.parse(q.to) - Date.parse(q.from)) / 86400000 <= 92, 'a range of at most 92 days');

const actorName = req => req.user.name || req.user.username;

/* A caller may read a day's amendment history if they could file one or could
   decide one. Reasons are free text about another department's figures. */
function canSee(user, formType) {
  if (A.isPrivileged(user)) return true;
  if ((ROLE_FORM_ACCESS[user.role] || []).includes(formType)) return true;
  return user.level === 'hod' && user.role === OWNING_ROLE_BY_FORM_TYPE[formType];
}

/* Shape a row for the client. Identifiers the page needs to decide what to
   offer (`requested_by`, so it can hide Grant on your own request) stay; the
   internals (baseline revision ids) do not. */
function present(row) {
  return {
    id: row.id, form_type: row.form_type, label: FORM_LABELS[row.form_type] || row.form_type,
    record_date: row.record_date, shift: row.shift, status: row.status,
    reason: row.reason, fields_flagged: row.fields_flagged || [],
    requested_by: row.requested_by, requested_by_name: row.requested_by_name,
    requested_at: row.requested_at, locked_status: row.locked_status,
    decided_by_name: row.decided_by_name, decided_at: row.decided_at, decision_note: row.decision_note,
    expires_at: row.expires_at, seconds_left: row.seconds_left ?? null, applied_at: row.applied_at,
  };
}

/* ── GET /api/amendments ────────────────────────────────────────────────
   What is scoped to the caller:
     admin / md     everything
     HOD            requests on the form types they APPROVE, plus their own
     officer/senior their OWN requests only
   The last row is a deliberate widening of routes/approvals.js, which returns
   [] for an officer because there is no "my submissions" view. Here the
   requester has to be able to see whether their request was granted, or they
   will simply ask again. Scoping on requested_by leaks nothing. */
router.get('/', requireAuth, validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { state, days } = req.validated.query;
    const params = [];
    const where = [];

    if (!A.isPrivileged(req.user)) {
      params.push(req.user.id);
      const mine = `a.requested_by = $${params.length}`;
      const approves = req.user.level === 'hod'
        ? Object.entries(OWNING_ROLE_BY_FORM_TYPE).filter(([, r]) => r === req.user.role).map(([f]) => f)
        : [];
      if (approves.length) {
        params.push(approves);
        where.push(`(${mine} OR a.form_type = ANY($${params.length}))`);
      } else {
        where.push(mine);
      }
    }

    params.push(A.OPEN_STATUSES);
    const openIdx = params.length;                 // reused below, so it is captured, not recomputed
    const open = `a.status = ANY($${openIdx})`;
    if (state === 'open') {
      where.push(open);
    } else {
      params.push(days);
      where.push(`(${open} OR a.requested_at >= NOW() - ($${params.length}::int * INTERVAL '1 day'))`);
    }

    const result = await db.query(`
      SELECT ${A.PRESENT_COLUMNS}, r.data AS report_data
        FROM report_amendments a
        LEFT JOIN daily_reports r
          ON r.form_type = a.form_type AND r.record_date = a.record_date AND r.shift = a.shift
       WHERE ${where.join(' AND ')}
       ORDER BY (a.status = ANY($${openIdx})) DESC, a.requested_at DESC
       LIMIT 200`, params);

    /* Give the approver the report's figures, the way routes/approvals.js does:
       deciding on a correction to numbers they cannot see is a blind signature.
       Only for undecided requests — once decided the figures are history. */
    res.json(result.rows.map(row => ({
      ...present(row),
      fields: row.status === 'requested'
        ? Object.entries(row.report_data || {})
            .filter(([k, v]) => !k.startsWith('_') && v !== '' && v !== null && v !== undefined)
            .map(([k, v]) => ({ key: k, label: prettifyField(k), value: v }))
        : [],
    })));
  } catch (err) { next(err); }
});

/* ── GET /api/amendments/days/:formType?from=&to= ───────────────────────
   The day picker behind corrections.html. "Which of last month's reports
   are wrong?" used to be answerable only by opening the entry form and
   stepping through the date field one day at a time — which is why a
   report approved with every field at zero could sit there with nobody
   finding the way to fix it. This answers it for a whole month in one read:
   each reported day's status and sign-off, how many figures it carries and
   how many of those are non-zero (a day that is all zeros or blanks is the
   commonest mistake, and the page flags it), and every correction request
   touching the range.

   Registered BEFORE GET /:formType/:date, which would otherwise take
   '/days/<form>' as formType='days' and 400 it.

   Visibility is canSee(): whoever may file this form or decide its
   corrections. The figures themselves are not returned — counts only. */
router.get('/days/:formType',
  requireAuth, validate(daysParams, 'params'), validate(daysQuery, 'query'),
  async (req, res, next) => {
    try {
      const { formType } = req.validated.params;
      const { from, to, shift } = req.validated.query;
      if (!canSee(req.user, formType)) {
        return res.status(403).json({ error: `Role '${req.user.role}' may not view '${formType}' reports.` });
      }

      const [days, ams] = await Promise.all([
        db.query(`
          SELECT r.record_date::text AS date, r.status,
                 r.submitted_at, r.approved_at, r.updated_at,
                 su.full_name AS submitted_by_name,
                 au.full_name AS approved_by_name,
                 (r.approved_by IS NOT NULL) AS human_signed,
                 f.filled, f.nonzero
            FROM daily_reports r
            LEFT JOIN users su ON su.id = r.submitted_by
            LEFT JOIN users au ON au.id = r.approved_by
            CROSS JOIN LATERAL (
              /* CASE, not AND: Postgres does not promise to test the regex
                 before attempting the cast, and one stray "1.2.3" would 500
                 the whole month. */
              SELECT COUNT(*) FILTER (WHERE e.value IS NOT NULL AND e.value NOT IN ('', 'null'))::int AS filled,
                     COUNT(*) FILTER (WHERE CASE WHEN e.value ~ '^-?[0-9]+(\\.[0-9]+)?$'
                                                 THEN e.value::numeric <> 0 ELSE false END)::int AS nonzero
                FROM jsonb_each_text(COALESCE(r.data, '{}'::jsonb)) e
               WHERE e.key !~ '^_' AND e.key NOT IN ('date', 'shift', 'prepared_by')
            ) f
           WHERE r.form_type = $1 AND r.record_date BETWEEN $2 AND $3 AND r.shift = $4
           ORDER BY r.record_date`, [formType, from, to, shift]),
        db.query(`
          SELECT ${A.PRESENT_COLUMNS}
            FROM report_amendments a
           WHERE a.form_type = $1 AND a.record_date BETWEEN $2 AND $3 AND a.shift = $4
             AND (a.status = ANY($5) OR COALESCE(a.decided_at, a.requested_at) > NOW() - INTERVAL '30 days')
           ORDER BY a.id DESC`, [formType, from, to, shift, A.OPEN_STATUSES]),
      ]);

      const owningRole = OWNING_ROLE_BY_FORM_TYPE[formType];
      res.json({
        form_type: formType,
        label: FORM_LABELS[formType] || formType,
        shift,
        /* What the page needs to say who will decide a request. The owning
           HOD cannot decide their own (mayDecide), so for them — and for the
           shared department logins that self-certify — it is admin/the MD. */
        approver_role: owningRole || null,
        you_approve: req.user.level === 'hod' && req.user.role === owningRole,
        can_request: (ROLE_FORM_ACCESS[req.user.role] || []).includes(formType),
        locked_statuses: A.LOCKED_STATUSES,
        days: days.rows,
        amendments: ams.rows.map(present),
      });
    } catch (err) { next(err); }
  });

/* ── POST /api/amendments/:formType/:date ───────────────────────────────── */
router.post('/:formType/:date',
  requireAuth, requireFormAccess,
  validate(formDateParams, 'params'), validate(requestBody, 'body'),
  async (req, res, next) => {
    try {
      const { formType, date } = req.validated.params;
      const { shift, reason, fields } = req.validated.body;

      const out = await db.withTransaction(async (client) => {
        const rep = await client.query(
          `SELECT status FROM daily_reports
            WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
          [formType, date, shift]);
        if (!rep.rows[0]) return { none: true };

        const status = rep.rows[0].status;
        if (!A.LOCKED_STATUSES.includes(status)) return { notLocked: status };

        /* ON CONFLICT on the partial unique index: two people noticing the same
           typo at once cannot open two windows. The loser gets the existing
           request back instead of an error. */
        const ins = await client.query(`
          INSERT INTO report_amendments
            (form_type, record_date, shift, reason, fields_flagged,
             requested_by, requested_by_name, locked_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (form_type, record_date, shift) WHERE status IN ('requested','granted')
          DO NOTHING
          RETURNING id`,
          [formType, date, shift, reason, fields, req.user.id, actorName(req), status]);

        if (!ins.rows[0]) return { existing: await A.findOpen(client, { formType, date, shift }) };

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address)
           VALUES ($1,$2,'REPORT_AMEND_REQUEST',$3,$4,$5,$6)`,
          [req.user.id, req.user.username, formType, date, reason.slice(0, 4000), req.ip]);

        return { amendment: await A.findOpen(client, { formType, date, shift }) };
      });

      if (out.none) {
        return res.status(404).json({ error: 'There is no report for that day to correct.', code: 'NO_REPORT' });
      }
      if (out.notLocked) {
        /* A draft or a rejected report is already editable. The reject-and-resubmit
           loop is the correction path there, and this feature must not grow a
           second one beside it. */
        return res.status(409).json({
          error: `This report is ${out.notLocked}, so it is already open for editing — correct it and submit again.`,
          code: 'REPORT_NOT_LOCKED', status: out.notLocked,
        });
      }
      if (out.existing) {
        return res.status(409).json({
          error: 'A correction request is already open for this report.',
          code: 'AMENDMENT_ALREADY_OPEN', amendment: present(out.existing),
        });
      }
      res.status(201).json({ success: true, amendment: present(out.amendment) });
    } catch (err) { next(err); }
  });

/* ── GET /api/amendments/:formType/:date ────────────────────────────────── */
router.get('/:formType/:date',
  requireAuth, validate(formDateParams, 'params'), validate(shiftQuery, 'query'),
  async (req, res, next) => {
    try {
      const { formType, date } = req.validated.params;
      const { shift } = req.validated.query;
      if (!canSee(req.user, formType)) {
        return res.status(403).json({ error: `Role '${req.user.role}' may not view '${formType}' corrections.` });
      }

      const [am, revs] = await Promise.all([
        db.query(
          `SELECT ${A.PRESENT_COLUMNS} FROM report_amendments a
            WHERE a.form_type = $1 AND a.record_date = $2 AND a.shift = $3
            ORDER BY a.id DESC`, [formType, date, shift]),
        /* The trail, WITHOUT prior_data: who changed what and why is public to
           anyone who may see the day; the old figures themselves stay in the
           table for an admin. */
        db.query(
          `SELECT revision, action, prior_status, changed_fields, actor_name, reason, created_at
             FROM report_revisions
            WHERE form_type = $1 AND record_date = $2 AND shift = $3
            ORDER BY revision DESC LIMIT 100`, [formType, date, shift]),
      ]);
      res.json({ amendments: am.rows.map(present), revisions: revs.rows });
    } catch (err) { next(err); }
  });

/* Resolve an amendment from the path and lock it in the right order: the
   REPORT row first, then the amendment — the same order the submit path and
   the expiry sweeper take, so none of the three can deadlock another. */
async function lockForDecision(client, { id, formType, date }) {
  const peek = await client.query(
    'SELECT form_type, record_date::text AS d, shift FROM report_amendments WHERE id = $1', [id]);
  if (!peek.rows[0] || peek.rows[0].form_type !== formType || peek.rows[0].d !== date) return { notFound: true };
  const shift = peek.rows[0].shift;

  const rep = await client.query(
    `SELECT data, status, approved_by, approved_at FROM daily_reports
      WHERE form_type = $1 AND record_date = $2 AND shift = $3 FOR UPDATE`,
    [formType, date, shift]);
  const am = await client.query('SELECT * FROM report_amendments WHERE id = $1 FOR UPDATE', [id]);
  return { shift, report: rep.rows[0] || null, amendment: am.rows[0] };
}

function decisionFailure(res, out) {
  if (out.notFound) return res.status(404).json({ error: 'No such correction request.', code: 'NOT_FOUND' });
  if (out.forbidden) return res.status(403).json({ error: out.forbidden.error, code: out.forbidden.code });
  if (out.notPending) {
    return res.status(409).json({
      error: `That request is already ${out.notPending} — it can no longer be decided.`,
      code: 'AMENDMENT_NOT_PENDING', status: out.notPending,
    });
  }
  if (out.notLocked !== undefined) {
    return res.status(409).json({
      error: 'That report is no longer approved or awaiting sign-off, so it is already open for editing.',
      code: 'REPORT_NOT_LOCKED', status: out.notLocked,
    });
  }
  return null;
}

/* ── POST …/:id/grant ───────────────────────────────────────────────────── */
router.post('/:formType/:date/:id/grant',
  requireAuth, requireApprover,
  validate(amendParams, 'params'), validate(grantBody, 'body'),
  async (req, res, next) => {
    try {
      const { formType, date, id } = req.validated.params;
      const { hours, note } = req.validated.body;

      const out = await db.withTransaction(async (client) => {
        const l = await lockForDecision(client, { id, formType, date });
        if (l.notFound) return l;
        if (l.amendment.status !== 'requested') return { notPending: l.amendment.status };

        const sod = A.mayDecide(l.amendment, req.user);
        if (!sod.ok) return { forbidden: sod };

        if (!l.report || !A.LOCKED_STATUSES.includes(l.report.status)) {
          return { notLocked: l.report ? l.report.status : null };
        }

        /* THE RESTORE POINT. Nothing is written to daily_reports here — that is
           the whole design — so this revision is a snapshot, not a pre-image of
           a change: the figures exactly as they stand, before anyone can edit.
           If the window closes unused the sweeper restores from it. */
        const rev = await recordRevision(client, {
          formType, recordDate: date, shift: l.shift, action: 'AMENDMENT_GRANT',
          priorData:       l.report.data,
          priorStatus:     l.report.status,
          priorApprovedBy: l.report.approved_by,
          priorApprovedAt: l.report.approved_at,
          amendmentId:     id,
          actorId:         req.user.id,
          actorName:       actorName(req),
          reason:          note || null,
          ipAddress:       req.ip,
        });

        await client.query(`
          UPDATE report_amendments SET
            status = 'granted', decided_by = $2, decided_by_name = $3, decided_at = NOW(),
            decision_note = $4, baseline_revision_id = $5,
            expires_at = NOW() + make_interval(hours => $6::int)
          WHERE id = $1`,
          [id, req.user.id, actorName(req), note || null, rev.id, hours]);

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address)
           VALUES ($1,$2,'REPORT_AMEND_GRANT',$3,$4,$5,$6)`,
          [req.user.id, req.user.username, formType, date,
           `Correction #${id} granted for ${hours} h` + (note ? ` — ${note}` : ''), req.ip]);

        return { amendment: await A.findOpen(client, { formType, date, shift: l.shift }) };
      });

      if (decisionFailure(res, out)) return;
      res.json({ success: true, amendment: present(out.amendment) });
    } catch (err) { next(err); }
  });

/* ── POST …/:id/decline ─────────────────────────────────────────────────── */
router.post('/:formType/:date/:id/decline',
  requireAuth, requireApprover,
  validate(amendParams, 'params'), validate(declineBody, 'body'),
  async (req, res, next) => {
    try {
      const { formType, date, id } = req.validated.params;
      const { note } = req.validated.body;

      const out = await db.withTransaction(async (client) => {
        const l = await lockForDecision(client, { id, formType, date });
        if (l.notFound) return l;
        if (l.amendment.status !== 'requested') return { notPending: l.amendment.status };

        const sod = A.mayDecide(l.amendment, req.user);
        if (!sod.ok) return { forbidden: sod };

        await client.query(`
          UPDATE report_amendments SET
            status = 'declined', decided_by = $2, decided_by_name = $3, decided_at = NOW(), decision_note = $4
          WHERE id = $1`, [id, req.user.id, actorName(req), note]);

        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address)
           VALUES ($1,$2,'REPORT_AMEND_DECLINE',$3,$4,$5,$6)`,
          [req.user.id, req.user.username, formType, date, `Correction #${id} declined — ${note}`, req.ip]);

        const am = await client.query(`SELECT ${A.PRESENT_COLUMNS} FROM report_amendments a WHERE a.id = $1`, [id]);
        return { amendment: am.rows[0] };
      });

      if (decisionFailure(res, out)) return;
      res.json({ success: true, amendment: present(out.amendment) });
    } catch (err) { next(err); }
  });

/* ── POST …/:id/withdraw ────────────────────────────────────────────────── */
router.post('/:formType/:date/:id/withdraw',
  requireAuth,
  validate(amendParams, 'params'),
  async (req, res, next) => {
    try {
      const { formType, date, id } = req.validated.params;

      const out = await db.withTransaction(async (client) => {
        const l = await lockForDecision(client, { id, formType, date });
        if (l.notFound) return l;
        if (l.amendment.status !== 'requested') return { notPending: l.amendment.status };
        if (!A.mayWithdraw(l.amendment, req.user)) {
          return { forbidden: { code: 'NOT_REQUESTER', error: 'Only the person who asked for a correction can withdraw it.' } };
        }

        await client.query(`UPDATE report_amendments SET status = 'withdrawn' WHERE id = $1`, [id]);
        await client.query(
          `INSERT INTO audit_log (user_id, username, action, form_type, record_date, details, ip_address)
           VALUES ($1,$2,'REPORT_AMEND_WITHDRAW',$3,$4,$5,$6)`,
          [req.user.id, req.user.username, formType, date, `Correction #${id} withdrawn`, req.ip]);

        const am = await client.query(`SELECT ${A.PRESENT_COLUMNS} FROM report_amendments a WHERE a.id = $1`, [id]);
        return { amendment: am.rows[0] };
      });

      if (decisionFailure(res, out)) return;
      res.json({ success: true, amendment: present(out.amendment) });
    } catch (err) { next(err); }
  });

module.exports = router;
