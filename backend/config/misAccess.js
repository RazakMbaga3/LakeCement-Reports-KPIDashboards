/*
  config/misAccess.js — which roles may read the MIS Dashboard's own
  reference data (routes/mis.js — GET /employees, /it-assets, /vehicles,
  /compliance-certs).

  Re-exports forms/access-registry.js's MIS_VIEW_ROLES (the single source
  of truth, shared with formAccess.js, kpiAccess.js and
  commercialAccess.js). Mirrors MIS_VIEW_ROLES + PERMISSIONS[role].mis_tabs
  in the frontend's auth.js — see backend/test/access-consistency.test.js
  for how the two stay in sync.

  SCOPE — this list gates the four reference-data routes above and nothing
  else in routes/mis.js. The rest of that router is deliberately left open
  to every authenticated user because it is NOT management-only data:

    /data-range, /completeness, /daily-summary/:date, /daily/:date
      — the KPI dashboard and Executive Summary run on these
        (index.html, app.js, kpi-data.js, analytics.js). Every department
        opens those pages.
    /monthly/:year/:month{,/html,/xlsx}
      — the monthly MIS pack, also reached from reports-export.html, which
        is open to all roles. Narrowing it would silently break exports
        that departments use today, so it is raised as a question rather
        than changed unasked.
*/
const { MIS_VIEW_ROLES } = require('../../forms/access-registry.js');

module.exports = { MIS_VIEW_ROLES };
