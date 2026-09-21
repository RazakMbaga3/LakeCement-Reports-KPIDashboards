# Draft mail — Production API request

> **Superseded 2026-09-20.** The Odoo team delivered the `production_report` endpoint, and the field-level questions in this request are now answered by its payload: the mapping is `backend/config/odooProductionMap.js`, the plan and status are in the "Odoo Production Autofill" doc. Still open with Odoo: an approval status on each entry, run hours or TPH, a Crusher group, and an RM1/RM2 tag on raw-meal entries. Kept for its field-level reasoning.

**To:** Odoo Development / Admin Team
**Cc:** Plant Head · IT Head
**From:** IT / MIS
**Subject:** Request — API access to Production Entry data (Crusher, Raw Meal, Coal Mill, Clinker, Cement)
**Attachment:** `ODOO_PRODUCTION_API_REQUIREMENTS.md` (full field-level spec)

---

Dear Team,

Requesting API access to Production Entry data. Details below.

**Model:** `custom.production.entry`

**Access (either):**
1. Read access via standard Odoo External API (service account + login/API key), or
2. A `production_report` endpoint, same pattern as `dispatch_report` / `mining_report` / `sale_dashboard_report` / `purchase_dashboard_report`.

**Fields required:**
- `name` (Reference), production date, picking type, product, UoM, produced qty, TPH, total input qty
- `state` (Status) and Approval Status
- Consumed Items line (one2many): product, UoM, input qty, moisture %, final qty after moisture correction — field name + target model to be confirmed
- Filter: Approved records only, by `from_date`/`to_date` (ISO `YYYY-MM-DD`) and Picking Type (Crusher / Raw Meal / Coal Mill / Clinker / Cement)

**Priority order:** Raw Meal, Cement (CM1/CM2), Clinker, Coal Mill, Crusher.

Full field mapping attached. Please confirm feasibility and timeline.

Regards,

[Name]
IT / MIS
Lake Cement Ltd
