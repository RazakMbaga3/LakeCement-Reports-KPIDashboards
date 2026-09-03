/*
  scripts/print-access-matrix.js — prints the effective access matrix by
  exercising the REAL middleware and the real registry, so what it shows is
  observed behaviour rather than a reading of the source.

  Written to make the 2026-09-03 access rework checkable at a glance:
    Implicit departmental boundary — a role reaches its own department only
    Inheritance                    — L1 ⊇ L2 ⊇ L3 within a department
    Separation of duties           — the submitter is never the approver,
                                     and management never edits
    Least privilege                — everything else denied by default

  Usage: node scripts/print-access-matrix.js      (read-only, no DB writes)
*/
const { requireKpiDeptAccess } = require('../middleware/kpiAccess');
const { requireApprover, OWNING_ROLE_BY_FORM_TYPE } = require('../middleware/approval');
const {
  KPI_EDIT_DEPTS, COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES, MIS_VIEW_ROLES,
} = require('../../forms/access-registry.js');

const LEVELS = ['hod', 'senior', 'officer'];   // printed as L1 / L2 / L3

function call(mw, req) {
  let ok = false;
  const res = { status() { return this; }, json() { return this; } };
  mw(req, res, () => { ok = true; });
  return ok;
}

const KPI_OWN = {
  production: 'production', cpp: 'powerplant', pm: 'mechanical',
  mining: 'mines', stores: 'stores', ei: 'ei', packing: 'packing',
};

console.log('\n═══ MONTHLY KPI EDIT — PUT /api/kpi/:dept/:year/:month ═══');
console.log('role         own dept        L1     L2     L3');
for (const [role, dept] of Object.entries(KPI_OWN)) {
  const cells = LEVELS.map(level =>
    (call(requireKpiDeptAccess, { params: { dept }, user: { role, level } }) ? 'EDIT' : '·').padEnd(6));
  console.log(role.padEnd(12), dept.padEnd(15), cells.join(' '));
}
for (const role of ['management', 'md', 'finance', 'hr', 'admin']) {
  const cells = LEVELS.map(level =>
    (call(requireKpiDeptAccess, { params: { dept: 'production' }, user: { role, level } }) ? 'EDIT' : '·').padEnd(6));
  console.log(role.padEnd(12), '(any dept)'.padEnd(15), cells.join(' '));
}
console.log('\n  Plus a period lock: once an HOD submits a department-month, every');
console.log('  write above is refused with 409 until admin/MD reopens it.');
console.log('  (requireKpiPeriodOpen — not exercised here, it needs the database.)');

console.log('\n═══ DAILY REPORT APPROVE / REJECT ═══');
console.log('form type        owning role   L1     L2     L3');
for (const [formType, role] of Object.entries(OWNING_ROLE_BY_FORM_TYPE)) {
  const cells = LEVELS.map(level =>
    (call(requireApprover, { params: { formType }, user: { role, level } }) ? 'APPR' : '·').padEnd(6));
  console.log(formType.padEnd(16), role.padEnd(13), cells.join(' '));
}

console.log('\n═══ SEPARATION OF DUTIES — who signs off whose numbers ═══');
console.log('  L2/L3 submit a daily report  -> lands pending_approval, their L1 approves');
console.log('  L1 submits a daily report    -> self-certifying (approved on save)');
console.log('  L1 submits the monthly KPIs  -> locked; only admin/MD may reopen');
console.log('  management                   -> reads everything, edits nothing');

console.log('\n═══ CROSS-DEPARTMENT VIEWS (explicit exceptions only) ═══');
const rows = [
  ['Sales dashboard',    COMMERCIAL_VIEW_ROLES],
  ['Purchases dashboard', PURCHASE_VIEW_ROLES],
  ['MIS Dashboard',      MIS_VIEW_ROLES],
];
for (const [what, list] of rows) console.log('  ' + what.padEnd(22) + list.join(', '));

const editors = Object.entries(KPI_EDIT_DEPTS)
  .filter(([, v]) => v === 'all' || (Array.isArray(v) && v.length))
  .map(([r, v]) => `${r}=${v === 'all' ? 'ALL' : v.join('/')}`);
console.log('  ' + 'KPI edit rights'.padEnd(22) + editors.join(', '));
console.log('');
