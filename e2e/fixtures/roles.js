/*
  The role matrix under test, mirrored from auth.js's PERMISSIONS.kpi and
  forms/access-registry.js's KPI_EDIT_DEPTS.

  This file is a DELIBERATE THIRD COPY: backend/test/access-consistency.test.js
  already guards auth.js against forms/access-registry.js statically, but that
  proves only that two source files agree — not that the running UI honours
  them. roles.spec.js drives a real browser against these expectations, so a
  regression in sidebar.js or applyKPIPermissions() is caught even when both
  registries still agree with each other.

  password: every e2e_* account is created by global-setup.js with this one
  password and must_change_password = false. No real staff account is ever
  touched or needed.
*/
const E2E_PASSWORD = 'E2E@Harness2026!';

/* dept keys as they appear in index.html's <section id="dept-KEY"> */
const ALL_KPI_DEPTS = [
  'summary', 'ei', 'production', 'mines', 'mechanical',
  'powerplant', 'packing', 'stores', 'minesworkshop',
];

const ROLES = [
  { role: 'admin',      view: 'all',                                          edit: 'all' },
  { role: 'md',         view: 'all',                                          edit: [] },
  { role: 'management', view: 'all',                                          edit: 'all' },
  { role: 'finance',    view: 'all',                                          edit: [] },
  { role: 'hr',         view: ['summary'],                                    edit: [] },
  { role: 'it',         view: ['summary'],                                    edit: [] },
  { role: 'sales',      view: ['summary'],                                    edit: [] },
  { role: 'purchase',   view: ['summary'],                                    edit: [] },
  { role: 'stores',     view: ['summary', 'stores'],                          edit: ['stores'] },
  { role: 'cpp',        view: ['summary', 'powerplant'],                      edit: ['powerplant'] },
  { role: 'pm',         view: ['summary', 'ei', 'mechanical'],                edit: ['mechanical'] },
  { role: 'mining',     view: ['summary', 'mines'],                           edit: ['mines'] },
  { role: 'production', view: ['summary', 'production', 'packing'],           edit: ['production'] },
  { role: 'ei',         view: ['summary', 'ei'],                              edit: ['ei'] },
  { role: 'packing',    view: ['summary', 'packing'],                         edit: ['packing'] },
  { role: 'logistics',  view: ['summary', 'packing', 'minesworkshop'],        edit: [] },
];

/* `level` is a second, orthogonal axis to `role` (migration 009): it decides
   only who may approve. The approval workflow needs both sides of it, so the
   harness creates an 'officer' twin for every role that owns a form type —
   e2e_production and e2e_production_officer are the same role at the two
   levels that matter. */
const FORM_OWNING_ROLES = ['production', 'pm', 'logistics', 'cpp', 'mining', 'stores', 'sales'];

const username = (role, level) =>
  'e2e_' + role + (level && level !== 'hod' ? '_' + level : '');
const expandView = r => (r.view === 'all' ? ALL_KPI_DEPTS : r.view);
/* 'all' still excludes the two sections that have nothing to fill: Executive
   Summary has no .data-row at all, and Mines Workshop's per-equipment matrix
   has no kpi_monthly rows behind it (openMonthlyModal refuses both). The Fill
   button must be hidden there for every role, admin included. */
const NON_FILLABLE = ['summary', 'minesworkshop'];
const expandEdit = r =>
  (r.edit === 'all' ? ALL_KPI_DEPTS : r.edit).filter(d => !NON_FILLABLE.includes(d));

module.exports = { ROLES, ALL_KPI_DEPTS, NON_FILLABLE, FORM_OWNING_ROLES, E2E_PASSWORD, username, expandView, expandEdit };
