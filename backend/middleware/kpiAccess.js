/*
  middleware/kpiAccess.js — 403s a KPI write unless the caller's role may
  edit the given :dept AND the caller is that department's HOD (L1).
  Replaces the old requireRole('admin','management') guard, which
  contradicted the client's per-department editDepts matrix and would have
  403'd every department HOD's "Fill Monthly Data" save.

  Two independent gates, because they answer different questions:

    WHICH departments  — ROLE_KPI_EDIT_DEPTS, keyed on `role`. A cpp user
                         may write 'powerplant' KPIs and nothing else.
    WHO in the dept    — `level`. Monthly KPI figures are the HOD's own
                         sign-off on the month, so only L1 may write them.
                         L2 (senior) and L3 (officer) fill and submit the
                         DAILY reports that feed those KPIs — that path is
                         routes/reports.js, gated separately and unchanged.

  The level gate is new as of 2026-08-28 (access model confirmed by the
  Plant Head). Before it, any senior or officer in an editing department
  could overwrite their own department's monthly targets and actuals.
*/
const { ROLE_KPI_EDIT_DEPTS } = require('../config/kpiAccess');
const db = require('../db');

function requireKpiDeptAccess(req, res, next) {
  const { dept } = req.params;
  const allowed = ROLE_KPI_EDIT_DEPTS[req.user.role] || [];
  if (allowed !== 'all' && !allowed.includes(dept)) {
    return res.status(403).json({ error: `Role '${req.user.role}' may not edit KPIs for department '${dept}'.` });
  }
  // `admin` is the break-glass system account, exempt the same way it is in
  // middleware/approval.js. Everyone else must be L1 to write a KPI value.
  if (req.user.role !== 'admin' && req.user.level !== 'hod') {
    return res.status(403).json({
      error: `Only a department HOD (L1) may edit monthly KPI values. Your account is level '${req.user.level || 'unknown'}' — fill and submit the daily reports instead, and your HOD signs them off.`,
    });
  }
  next();
}

/* 409s a KPI write for a department-month whose HOD has already submitted
   it. "HODs edit for submission and cannot edit after submitting" — the
   figures become management's read-only record at the moment they are
   declared final, and reopening is an explicit, audited act by admin/MD
   rather than a silent overwrite.

   Ordered AFTER requireKpiDeptAccess in the route so a caller who may not
   touch this department at all is told that, rather than being told the
   month is locked — the more specific refusal would leak that the
   department-month exists.

   `admin` is NOT exempt here. The break-glass exemption in
   requireKpiDeptAccess is about WHICH department, and repairing a
   submitted month should still go through reopen so the reason is
   recorded. */
async function requireKpiPeriodOpen(req, res, next) {
  try {
    const { dept, year, month } = req.params;
    const { rows } = await db.query(
      `SELECT status, submitted_at, u.full_name AS submitted_by_name
         FROM kpi_submissions s
         LEFT JOIN users u ON u.id = s.submitted_by
        WHERE s.department = $1 AND s.year = $2 AND s.month = $3`,
      [dept, year, month]
    );
    const sub = rows[0];
    if (sub && sub.status === 'submitted') {
      const who  = sub.submitted_by_name || 'the department HOD';
      const when = sub.submitted_at ? new Date(sub.submitted_at).toISOString().slice(0, 10) : 'an earlier date';
      return res.status(409).json({
        error: `${dept} ${year}-${String(month).padStart(2, '0')} was submitted by ${who} on ${when} and is locked. An administrator or the MD must reopen it before it can be edited.`,
        code: 'KPI_PERIOD_LOCKED',
        submitted_at: sub.submitted_at,
        submitted_by: sub.submitted_by_name,
      });
    }
    next();
  } catch (err) { next(err); }
}

module.exports = { requireKpiDeptAccess, requireKpiPeriodOpen };
