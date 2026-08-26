/*
  routes/approvals.js — list reports awaiting HOD sign-off.

  GET /api/approvals → pending_approval daily_reports, scoped to the caller:
    admin/md            → every pending report, any department
    level='hod'         → only reports whose form_type this role owns
                           (ROLE_FORM_ACCESS[role] — same map requireFormAccess
                           and requireApprover already use)
    officer/senior      → [] (no "my own submissions" view yet — plausible
                           future addition, not built this round)

  A separate router rather than a route on reports.js, since that file's
  GET /:formType catch-all validates formType against VALID_FORMS and this
  isn't one.
*/
const express = require('express');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ROLE_FORM_ACCESS } = require('../config/formAccess');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { role, level } = req.user;

    let formTypes = null; // null = no department filter (admin/md see everything)
    if (role !== 'admin' && role !== 'md') {
      if (level !== 'hod') return res.json([]);
      formTypes = ROLE_FORM_ACCESS[role] || [];
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
    res.json(result.rows);
  } catch (err) { next(err); }
});

module.exports = router;
