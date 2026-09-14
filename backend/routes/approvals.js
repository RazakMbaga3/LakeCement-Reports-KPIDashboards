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
    query += ` ORDER BY r.submitted_at ASC`;

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
