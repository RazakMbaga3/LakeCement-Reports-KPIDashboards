/*
  middleware/kpiAccess.js — 403s a KPI write if this role may not edit the
  given :dept. Replaces the old requireRole('admin','management') guard,
  which contradicted the client's per-department editDepts matrix and would
  have 403'd every department HOD's "Fill Monthly Data" save.
*/
const { ROLE_KPI_EDIT_DEPTS } = require('../config/kpiAccess');

function requireKpiDeptAccess(req, res, next) {
  const { dept } = req.params;
  const allowed = ROLE_KPI_EDIT_DEPTS[req.user.role] || [];
  if (allowed !== 'all' && !allowed.includes(dept)) {
    return res.status(403).json({ error: `Role '${req.user.role}' may not edit KPIs for department '${dept}'.` });
  }
  next();
}

module.exports = { requireKpiDeptAccess };
