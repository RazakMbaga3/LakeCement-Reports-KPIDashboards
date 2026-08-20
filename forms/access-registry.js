/* ══════════════════════════════════════════════════════════════════
   Nyati Cement — Role Access Registry (single source of truth)
   ─────────────────────────────────────────────────────────────────
   Same dual-runtime pattern as forms/formula-registry.js. Required
   directly by the backend's config/formAccess.js, config/kpiAccess.js
   and config/commercialAccess.js (each just re-exports its slice — no
   other backend file needs to change how it imports them).

   The frontend's auth.js is a plain global script loaded on ~27 pages
   with no build step and no module loader, so it can't `require()` this
   file the way the backend does without adding a new mandatory <script>
   tag to every page — a change with real regression risk this session
   has no live browser to verify. Instead, auth.js keeps its own literal
   copies of these three maps, and backend/test/access-consistency.test.js
   parses auth.js's source and diffs it against this file on every CI
   run — so a future edit to one side without the other now fails the
   build loudly instead of shipping silently (exactly the bug class that
   let admin/management lose their KPI-edit rights until caught in the
   2026-08-19 audit).

   Three independent maps, one per axis of "what can this role do":
     FORM_ACCESS           — which daily-report form_types a role may SUBMIT
     KPI_EDIT_DEPTS         — which KPI dashboard departments a role may EDIT
     COMMERCIAL_VIEW_ROLES  — which roles may see Sales/Purchases dashboards
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var FORM_ACCESS = {
    production: ['production', 'quality', 'limestone', 'pile-quality'],
    pm:         ['stoppage', 'power-cons'],   // P&M owns Stoppage & Power Cons. reports
    logistics:  ['dispatch'],
    cpp:        ['power-plant', 'cpp'],
    mining:     ['mines'],
    stores:     ['materials'],                // Raw Materials report is owned by Purchase & Stores
    sales:      ['sales-projection'],
    hr: [], it: [], md: [], admin: [], management: [], finance: [],
  };

  var KPI_EDIT_DEPTS = {
    admin:      'all',
    management: 'all',
    stores:     ['stores'],
    cpp:        ['powerplant'],
    pm:         ['mechanical'],
    mining:     ['mines'],
    production: ['production'],
    md: [], hr: [], finance: [], it: [], logistics: [], sales: [],
  };

  var COMMERCIAL_VIEW_ROLES = ['md', 'sales'];

  var api = { FORM_ACCESS: FORM_ACCESS, KPI_EDIT_DEPTS: KPI_EDIT_DEPTS, COMMERCIAL_VIEW_ROLES: COMMERCIAL_VIEW_ROLES };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiAccess = api;

}(typeof window !== 'undefined' ? window : globalThis));
