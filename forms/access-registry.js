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
    production: ['production', 'quality', 'limestone', 'pile-quality', 'stoppage'],   // Stoppage transferred from P&M 2026-09-22 — Production now fills AND (via approval.js's single-submitter rule) its own HOD approves it
    quality:    ['quality', 'limestone', 'pile-quality'],   // QC Manager — added 2026-09-22, see the note under FORM_APPROVAL_OWNER. Production keeps all three and still approves them.
    pm:         ['power-cons'],   // Stoppage moved to Production 2026-09-22 — P&M keeps read-only access to stoppage-form.html/reliability.html but no submit right, see forms/stoppage-form.html's view-only mode. Power Cons. still submitted by both P&M and E&I — E&I approves, see FORM_APPROVAL_OWNER
    logistics:  ['dispatch'],   // Dispatch & SO submitted by both Logistics and Packing — Logistics approves, see FORM_APPROVAL_OWNER
    cpp:        ['cpp'],   // 'power-plant' retired 2026-08-31 — see config/forms.js
    mining:     ['mines'],
    stores:     ['materials'],                // Raw Materials report is owned by Purchase & Stores
    sales:      ['sales-projection'],
    ei:         ['power-cons'],   // E&I owns Power Cons. readings (kWh/meters) — P&M keeps submit rights too, see pm above
    packing:    ['dispatch'],     // Packing Plant fills the Dispatch & SO report — it's their core daily report; Logistics keeps submit rights and signs it off, see logistics above
    hr: [], it: [], md: [], admin: [], management: [], finance: [], purchase: [],
  };

  /* Which role's HOD APPROVES a form type that more than one role may submit.

     FORM_ACCESS answers "who may submit"; approval is a separate question,
     and for a shared form type the two answers differ. backend/middleware/
     approval.js derives a single approving role per form type from
     FORM_ACCESS and throws at startup if two roles claim one — deliberately,
     so an accidental overlap can never silently pick an approver. An entry
     here is the explicit, deliberate answer that satisfies that guard.

     power-cons: both P&M and E&I submit readings (E&I took submit rights
     2026-09-11 — it's their main daily report), but E&I's HOD signs them
     off, since E&I owns the kWh/meter readings themselves. Declared
     2026-09-13 after the un-declared overlap took the server down at boot.

     dispatch: both Logistics and Packing submit (Packing took submit rights
     2026-09-14 — the Dispatch & SO report is their core daily report), but
     Logistics' HOD signs them off. Logistics already approved this form
     type and the ask was only to let Packing fill it, so nobody loses a
     right they had; it also keeps author and approver in different
     departments, which is the Separation-of-Duties rule stated below. */
  var FORM_APPROVAL_OWNER = {
    'power-cons': 'ei',
    'dispatch':   'logistics',
    /* The three lab reports, 2026-09-22. `quality` (the QC Manager and the
       lab officers under them) was added as a submitter because the QC
       Daily Report is their own sheet — they measure every figure on it —
       and until now the only people who could file it were Production,
       who receive those figures rather than produce them.

       Production keeps the submit right and keeps the sign-off. That is
       deliberate on two counts. Nobody loses a right they already had,
       which is the same standard applied when Packing was added to
       dispatch. And it puts author and approver in different departments,
       which is the Separation-of-Duties rule stated below — the printed
       sign-off strip on forms/quality-form.html already reads Lab Analyst
       → QC Manager → Production Head, so this is the paper trail the
       plant already runs, expressed in the access model. */
    'quality':      'production',
    'limestone':    'production',
    'pile-quality': 'production',
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
    /* `quality` edits no KPI department. The lab reports figures into
       Production's KPIs; it does not own a department section of its own
       on index.html, and inventing one would create a KPI department with
       no targets, no history and nobody accountable for it. */
    quality:    [],
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

     `admin` was absent from both until 2026-10-16, on the same reasoning
     that kept it off: the IT/system account, not a commercial one, had
     never needed these rights. Added 2026-10-16 at Razak's explicit
     request, as a break-glass read grant alongside its existing
     KPI_EDIT_DEPTS 'all' — not because admin became a commercial role.

     `stores` reads Purchases as of 2026-09-14. This is not the same shape
     of grant as the `sales` one removed above: Stores receives the goods
     against the very POs this dashboard lists, so the orders are one half
     of a transaction whose other half they already own — they need to see
     what is on order and when it lands to plan space and raise the GRN.
     Read-only, like every other role on this list; Purchase still owns
     the data and is still the only department that raises a PO. */
  var COMMERCIAL_VIEW_ROLES = ['management', 'md', 'sales', 'admin'];
  var PURCHASE_VIEW_ROLES   = ['management', 'md', 'purchase', 'stores', 'admin'];

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

  var api = { FORM_ACCESS: FORM_ACCESS, FORM_APPROVAL_OWNER: FORM_APPROVAL_OWNER, KPI_EDIT_DEPTS: KPI_EDIT_DEPTS, KPI_DEPTS: KPI_DEPTS, COMMERCIAL_VIEW_ROLES: COMMERCIAL_VIEW_ROLES, PURCHASE_VIEW_ROLES: PURCHASE_VIEW_ROLES, RAWMAT_VIEW_ROLES: RAWMAT_VIEW_ROLES, MINES_VIEW_ROLES: MINES_VIEW_ROLES, MIS_VIEW_ROLES: MIS_VIEW_ROLES };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.NyatiAccess = api;

}(typeof window !== 'undefined' ? window : globalThis));
