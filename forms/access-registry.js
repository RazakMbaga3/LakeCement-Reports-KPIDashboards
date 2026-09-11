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

   Independent maps, one per axis of "what can this role do":
     FORM_ACCESS           — which daily-report form_types a role may SUBMIT
     KPI_EDIT_DEPTS         — which KPI dashboard departments a role may EDIT
     COMMERCIAL_VIEW_ROLES  — which roles may see the Sales dashboard
     PURCHASE_VIEW_ROLES    — which roles may see the Purchases dashboard
     RAWMAT_VIEW_ROLES      — which roles may see raw-material stock figures
     MINES_VIEW_ROLES       — which roles may see Quarry figures
   ══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var FORM_ACCESS = {
    production: ['production', 'quality', 'limestone', 'pile-quality'],
    pm:         ['stoppage', 'power-cons'],   // P&M owns Stoppage; Power Cons. shared with E&I below
    logistics:  ['dispatch'],
    cpp:        ['cpp'],   // 'power-plant' retired 2026-08-31 — see config/forms.js
    mining:     ['mines'],
    stores:     ['materials'],                // Raw Materials report is owned by Purchase & Stores
    sales:      ['sales-projection'],
    ei:         ['power-cons'],   // E&I owns Power Cons. readings (kWh/meters) — P&M keeps it too, see pm above
    hr: [], it: [], md: [], admin: [], management: [], finance: [], packing: [], purchase: [],
  };

  /* Which departments a role may WRITE monthly KPI values for.

     `management` was 'all' until 2026-09-03 and is now [] — deliberately.
     Management (CFO, GM, Plant Head, Strategic Business Head, MD) reads
     every department and writes none: the numbers are the HOD's own
     submission and sign-off, so a manager editing them would erase the
     accountability the whole approval chain exists to create. This is the
     Separation-of-Duties rule — whoever reports a figure is not whoever
     reviews it.

     `admin` keeps 'all' as the break-glass system account (data repair,
     import fixes), not as a business role. Every other entry is the one
     department that role owns. See also the L1-only level gate in
     backend/middleware/kpiAccess.js — role says WHICH department, level
     says WHO in it, and a KPI write needs both. */
  var KPI_EDIT_DEPTS = {
    admin:      'all',
    management: [],
    stores:     ['stores'],
    cpp:        ['powerplant'],
    pm:         ['mechanical'],
    mining:     ['mines'],
    production: ['production'],
    ei:         ['ei'],
    packing:    ['packing'],
    md: [], hr: [], finance: [], it: [], logistics: [], sales: [], purchase: [],
  };

  /* The complete set of KPI department keys — the <section id="dept-KEY">
     ids on index.html, which are also kpi_monthly.department values.

     PUT /api/kpi/:dept/... used to accept any /^[a-z0-9_-]+$/i string, so a
     role with editDepts 'all' could write rows under a mistyped department
     that no page would ever render — invisible data nothing reports.
     Validating against this list turns a silent orphan into a 400.
     (backend/test/kpi-keys.test.js catches orphans that arrive by other
     routes, e.g. scripts/import-kpi-monthly.js writing straight to the DB.) */
  var KPI_DEPTS = [
    'ei', 'production', 'mines', 'mechanical',
    'powerplant', 'packing', 'stores', 'minesworkshop',
  ];

  /* Which roles may see raw-material stock, and which may see the Quarry.

     Added for the Executive Summary's Daily Summary Report: it puts stock
     levels and quarry movements on the one page every role can open, so
     without a gate it would have been a side door around
     PERMISSIONS[role].store.rawmat and PERMISSIONS[role].kpi.depts. Both
     lists are DERIVED from auth.js's PERMISSIONS, not invented here —
     backend/test/access-consistency.test.js recomputes them from auth.js's
     source and fails if they drift, the same guardrail the four maps above
     already have.

       RAWMAT_VIEW_ROLES — PERMISSIONS[role].store.rawmat is truthy
       MINES_VIEW_ROLES  — PERMISSIONS[role].kpi.depts covers 'mines' */
  var RAWMAT_VIEW_ROLES = ['admin', 'finance', 'management', 'md', 'mining', 'production', 'stores'];
  var MINES_VIEW_ROLES  = ['admin', 'finance', 'management', 'md', 'mining'];

  /* Sales and Purchases: the owning department plus management oversight.

     `sales` used to appear in PURCHASE_VIEW_ROLES — Purchases originally
     rode on Sales' gate for lack of one of its own, and when it was split
     out in 2026-09-03's predecessor change `sales` kept that incidental
     access rather than lose it silently. Removed 2026-09-03: Sales has no
     business reason to read Purchases, and carrying a permission forward
     only because it already existed is exactly what Least Privilege
     forbids. Each dashboard is now its own department plus management.

     `admin` is deliberately absent from both. It is the IT/system account,
     not a commercial one, and it has never had these rights. */
  var COMMERCIAL_VIEW_ROLES = ['management', 'md', 'sales'];
  var PURCHASE_VIEW_ROLES   = ['management', 'md', 'purchase'];

  /* The MIS Dashboard (mis.html — the sidebar's "Management Info." group)
     is management-only as of 2026-09-03. It aggregates HR strength,
     asset registers, compliance certificates and store positions across
     every department, so under the Implicit Departmental Boundary rule no
     single department has grounds to read it. Before this, twelve roles
     carried non-empty mis_tabs and the backend enforced nothing at all —
     every route in backend/routes/mis.js was requireAuth only.

     `admin` is included as the system account that maintains the page.
     `planthead` is not listed because it holds role 'md'. */
  var MIS_VIEW_ROLES = ['admin', 'management', 'md'];

  var api = { FORM_ACCESS: FORM_ACCESS, KPI_EDIT_DEPTS: KPI_EDIT_DEPTS, KPI_DEPTS: KPI_DEPTS, COMMERCIAL_VIEW_ROLES: COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES: PURCHASE_VIEW_ROLES, RAWMAT_VIEW_ROLES: RAWMAT_VIEW_ROLES, MINES_VIEW_ROLES: MINES_VIEW_ROLES, MIS_VIEW_ROLES: MIS_VIEW_ROLES };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiAccess = api;

}(typeof window !== 'undefined' ? window : globalThis));
