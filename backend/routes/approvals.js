/*
  routes/approvals.js — list reports awaiting HOD sign-off.

  GET /api/approvals → pending_approval daily_reports, scoped to the caller:
    admin/md            → every pending report, any department
    level='hod'         → only reports whose form_type this role APPROVES
                           (OWNING_ROLE_BY_FORM_TYPE — the exact map
                           requireApprover enforces on the approve/reject
                           call itself)
    officer/senior      → [] (no "my own submissions" view yet — plausible
                           future addition, not built this round)

  Scoped on who approves, not on who submits. The two were the same thing
  until a form type could be shared (see FORM_APPROVAL_OWNER in
  forms/access-registry.js). Listing by ROLE_FORM_ACCESS after that would
  put a report in an HOD's queue that requireApprover then 403s — P&M's HOD
  would be asked to sign off Power Cons. reports E&I owns, and Packing's
  would be asked to sign off Dispatch & SO. A queue must only ever offer
  actions the caller can actually complete.

  A separate router rather than a route on reports.js, since that file's
  GET /:formType catch-all validates formType against VALID_FORMS and this
  isn't one.
*/
const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { OWNING_ROLE_BY_FORM_TYPE } = require('../middleware/approval');
const { FORM_LABELS, prettifyField } = require('../services/misReport');

const router = express.Router();

/* The form types this user signs off: null = every one (admin/md), [] = none. */
function approvableFormTypes({ role, level }) {
  if (role === 'admin' || role === 'md') return null;
  if (level !== 'hod') return [];
  return Object.entries(OWNING_ROLE_BY_FORM_TYPE)
    .filter(([, owningRole]) => owningRole === role)
    .map(([formType]) => formType);
}

/* ── GET /api/approvals/counts ──────────────────────────────────────────
   How much is waiting on this user, for the number on the sidebar's
   Approvals row and the phone's Approve tab. Before this the only way an
   approver learnt that somebody had asked for a correction was to open the
   Approvals page and look — so a request could sit for days while the
   person who filed it assumed it had been seen.

     reports      pending_approval reports they may sign off
     corrections  correction requests they may DECIDE — their own are left
                  out, since mayDecide() would refuse them anyway
     kpiReopens   monthly-KPI reopen requests (admin/md only — only they
                  may reopen a submitted month)
     myWindows    correction windows open for THIS user right now: the one
                  thing an officer has to act on, and on a clock

   Counts only, never rows: this is read on every page load. */
router.get('/counts', requireAuth, async (req, res, next) => {
  try {
    const types = approvableFormTypes(req.user);
    const privileged = types === null;
    const none = Array.isArray(types) && types.length === 0;

    const [reports, corrections, kpiReopens, mine] = await Promise.all([
      none ? { rows: [{ n: 0 }] } : db.query(
        `SELECT COUNT(*)::int AS n FROM daily_reports
          WHERE status = 'pending_approval'${privileged ? '' : ' AND form_type = ANY($1)'}`,
        privileged ? [] : [types]),
      none ? { rows: [{ n: 0 }] } : db.query(
        `SELECT COUNT(*)::int AS n FROM report_amendments
          WHERE status = 'requested'
            AND (requested_by IS NULL OR requested_by <> $1 OR $2)
            ${privileged ? '' : 'AND form_type = ANY($3)'}`,
        privileged ? [req.user.id, true] : [req.user.id, false, types]),
      privileged
        ? db.query(`SELECT COUNT(*)::int AS n FROM kpi_reopen_requests WHERE status = 'requested'`)
        : { rows: [{ n: 0 }] },
      db.query(
        `SELECT COUNT(*)::int AS n FROM report_amendments
          WHERE requested_by = $1 AND status = 'granted' AND expires_at > NOW()`, [req.user.id]),
    ]);

    const out = {
      reports:     reports.rows[0].n,
      corrections: corrections.rows[0].n,
      kpiReopens:  kpiReopens.rows[0].n,
      myWindows:   mine.rows[0].n,
    };
    out.total = out.reports + out.corrections + out.kpiReopens;
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { role, level } = req.user;

    let formTypes = null; // null = no department filter (admin/md see everything)
    if (role !== 'admin' && role !== 'md') {
      if (level !== 'hod') return res.json([]);
      formTypes = Object.entries(OWNING_ROLE_BY_FORM_TYPE)
        .filter(([, owningRole]) => owningRole === role)
        .map(([formType]) => formType);
      if (formTypes.length === 0) return res.json([]);
    }

    const params = [];
    let query = `
      SELECT r.*, u.full_name AS submitted_by_name
      FROM daily_reports r
      LEFT JOIN users u ON r.submitted_by = u.id
      WHERE r.status = 'pending_approval'
    `;
    if (formTypes) {
      params.push(formTypes);
      query += ` AND r.form_type = ANY($${params.length})`;
    }
    /* A person's submission first, then the rows the Odoo pulls filled
       (submitted_by IS NULL — they never set it). Oldest-first alone put a
       Power Plant officer's 10 Oct report at row 138 of 138 for admin/MD,
       under ~96 production and ~41 raw-material days the pulls leave
       pending — the approver reported it "not in the queue" (2026-10-12). */
    query += ` ORDER BY (r.submitted_by IS NULL), r.submitted_at ASC`;

    const result = await db.query(query, params);

    /* Give the approver the report's own name and its figures. The page used
       to title-case the raw slug ("Cpp", "Power Cons") and show only a
       `remarks` field, so an HOD was asked to sign off on numbers the screen
       never showed them — they had to open the form separately to see what
       they were approving. FORM_LABELS is the same catalogue the MIS pack
       uses; `fields` is the row's own data, prettified. */
    res.json(result.rows.map(r => ({
      ...r,
      label: FORM_LABELS[r.form_type] || r.form_type,
      fields: Object.entries(r.data || {})
        .filter(([k, v]) => !k.startsWith('_') && v !== '' && v !== null && v !== undefined)
        .map(([k, v]) => ({ key: k, label: prettifyField(k), value: v })),
    })));
  } catch (err) { next(err); }
});

module.exports = router;
