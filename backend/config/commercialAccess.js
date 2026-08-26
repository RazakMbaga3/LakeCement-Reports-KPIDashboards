/*
  config/commercialAccess.js — which roles may VIEW the Sales/Purchases
  commercial dashboards (routes/sales.js, routes/purchases.js — GET
  /dashboard, GET /territories).

  Re-exports forms/access-registry.js's COMMERCIAL_VIEW_ROLES and
  PURCHASE_VIEW_ROLES (the single source of truth, shared with
  formAccess.js and kpiAccess.js) under their original names so every
  existing `require('../config/commercialAccess')` call site is
  unaffected. Mirrors PERMISSIONS[role].commercial.{sales,purchase} in
  the frontend's auth.js — see backend/test/access-consistency.test.js
  for how this stays in sync. Read access to sales_targets writes (POST
  /api/sales/targets) is unaffected — that already has its own
  requireRole('sales', 'admin', 'md') and validates officerCode against
  the DB directly, independent of this list.
*/
const { COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES } = require('../../forms/access-registry.js');

module.exports = { COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES };
