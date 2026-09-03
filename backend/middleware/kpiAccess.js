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

module.exports = { requireKpiDeptAccess };
