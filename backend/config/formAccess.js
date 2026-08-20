/*
  config/formAccess.js — which roles may SUBMIT which daily-report form types.

  Re-exports forms/access-registry.js's FORM_ACCESS (the single source of
  truth, shared with kpiAccess.js and commercialAccess.js) under its
  original name so every existing `require('../config/formAccess')` call
  site is unaffected. See backend/test/access-consistency.test.js for how
  this stays in sync with auth.js's own copy.
*/
const { FORM_ACCESS } = require('../../forms/access-registry.js');

module.exports = { ROLE_FORM_ACCESS: FORM_ACCESS };
