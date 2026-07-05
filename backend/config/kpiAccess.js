/*
  config/kpiAccess.js — which roles may WRITE monthly KPI values (kpi_monthly)
  for which departments.

  Mirrors PERMISSIONS[role].kpi.editDepts in the frontend's auth.js — keep
  both in sync. 'all' = any department. Dept keys match the dashboard's
  data-dept values: summary, ei, production, mines, mechanical, powerplant,
  packing, stores, minesworkshop.

  admin/management keep the 'all' rights the old requireRole('admin',
  'management') guard gave them; department HODs get exactly the depts the
  client-side "Fill Monthly Data" button already offers them — previously
  those HODs would have been 403'd by the server the moment the button was
  wired to the real endpoint.
*/
const ROLE_KPI_EDIT_DEPTS = {
  admin:      'all',
  management: 'all',
  stores:     ['stores'],
  cpp:        ['powerplant'],
  pm:         ['mechanical'],
  mining:     ['mines'],
  production: ['production'],
  md: [], hr: [], finance: [], it: [], logistics: [],
};

module.exports = { ROLE_KPI_EDIT_DEPTS };
