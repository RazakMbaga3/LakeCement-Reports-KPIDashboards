/*
  config/itAssetsAccess.js — which roles may read vs write the IT Asset
  Register (routes/itAssets.js).

  NOT drawn from forms/access-registry.js, unlike config/misAccess.js's
  MIS_VIEW_ROLES. That registry is the shared cross-cutting contract that
  auth.js's frontend PERMISSIONS object mirrors and
  backend/test/access-consistency.test.js enforces byte-for-byte — a
  contract worth its weight for FORM_ACCESS/KPI_EDIT_DEPTS/MIS_VIEW_ROLES
  because those gates are read from BOTH sides (the frontend hides a tab
  AND the backend enforces the same rule) and drift between them is a real,
  previously-realized incident (the 2026-08-19 admin/management KPI-edit
  mismatch the registry's own header comment cites). This register has no
  frontend counterpart yet — it-assets.html and its sidebar entry are a
  separate, not-yet-built task — so there is nothing on the other side for
  these two lists to drift FROM. Joining the shared registry now would add
  a maintenance obligation (a mirrored auth.js entry, a matching
  access-consistency.test.js case) for a rule only this one route file
  reads. If/when the frontend page ships and needs to hide itself from a
  role that cannot open it, THAT is the moment to promote these into
  forms/access-registry.js the way MIS_VIEW_ROLES was — not before.

  THE DECISION:
    write (create/update/delete/import) — 'admin', 'it'
    read  (list/summary)                — 'admin', 'it', 'management', 'md'

  IT owns this register the same way Purchase owns Purchases or Sales owns
  Sales — the department that maintains the underlying reality edits it.
  `admin` is the break-glass system account, included the same way
  admin.js and KPI_EDIT_DEPTS include it for data repair, not as a business
  role. Read access extends to `management` and `md` because this mirrors
  the same oversight pattern as MIS_VIEW_ROLES/COMMERCIAL_VIEW_ROLES/
  PURCHASE_VIEW_ROLES: senior management and the Plant Head can see any
  department's operational register without being able to edit it. No
  other department has a standing business reason to browse IT's asset
  list, so nobody else is on the read list either — the Implicit
  Departmental Boundary rule the other registries already state.
*/

const IT_ASSETS_WRITE_ROLES = ['admin', 'it'];
const IT_ASSETS_READ_ROLES  = ['admin', 'it', 'management', 'md'];

module.exports = { IT_ASSETS_WRITE_ROLES, IT_ASSETS_READ_ROLES };
