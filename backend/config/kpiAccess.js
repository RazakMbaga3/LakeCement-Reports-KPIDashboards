/*
  config/kpiAccess.js — which roles may WRITE monthly KPI values
  (kpi_monthly) for which departments.

  Re-exports forms/access-registry.js's KPI_EDIT_DEPTS (the single source
  of truth, shared with formAccess.js and commercialAccess.js) under its
  original name so every existing `require('../config/kpiAccess')` call
  site is unaffected. See backend/test/access-consistency.test.js for how
  this stays in sync with auth.js's own copy — this is the exact map
  whose admin/management entries drifted from auth.js until the
  2026-08-19 audit caught it.
*/
const { KPI_EDIT_DEPTS, KPI_DEPTS } = require('../../forms/access-registry.js');

module.exports = { ROLE_KPI_EDIT_DEPTS: KPI_EDIT_DEPTS, KPI_DEPTS: KPI_DEPTS };
