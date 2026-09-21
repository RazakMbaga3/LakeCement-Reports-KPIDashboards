# Lake Cement MIS — Production Data API Requirements (for Odoo Team)

> **Superseded 2026-09-20.** The Odoo team delivered the `production_report` endpoint, and the field-level questions in this request are now answered by its payload: the mapping is `backend/config/odooProductionMap.js`, the plan and status are in the "Odoo Production Autofill" doc. Still open with Odoo: an approval status on each entry, run hours or TPH, a Crusher group, and an RM1/RM2 tag on raw-meal entries. Kept for its field-level reasoning.

**Audience:** Odoo development/admin team
**Purpose:** Specify exactly what API access is needed to pull daily Production data (Crusher, Raw Meal, Coal Mill, Clinker, Cement) out of Odoo and into the MIS, so plant staff stop typing the same tonnages twice.
**Related:** `docs/TECHNICAL_SPEC.md` (system overview for the Odoo team), `docs/KPI_REFERENCE.md` (what these numbers feed), `services/odooClient.js` / `odooDispatchClient.js` / `odooMiningClient.js` / `odooDashboardClient.js` (existing integrations this follows the pattern of)
**Evidence base:** on-site screen captures of `erp.lakecement.co.tz`, 11-Sep-2026, model `custom.production.entry`
**Status date:** 2026-09-15

---

## 1. The problem

Production staff enter the same tonnages twice: once into Odoo's Production Entry screens during the shift, and again into `daily-report.html`'s Plant Operations tables at end of day. Nearly every number the plant types into Odoo — production quantities, moisture-corrected consumption, stock movement — has a matching manually-typed field on the MIS. That's duplicate keying and a standing source of transcription drift between the two systems of record.

The MIS already has three live Odoo integrations built on exactly this pattern (dispatch summaries, mining weighbridge tickets, sales/purchase dashboards), and a fourth — "Production Entry Raw Meal" — was already flagged as an open, unconfirmed item in `services/odooSync.js` before this document existed. This is that request, made concrete at the field level.

## 2. What we already know about the source data

The Production menu in Odoo (Operations app) shows five list views that all point at the **same underlying model**, distinguished only by a "Picking Type" field:

| List view | action id | Picking Type value observed | Product |
|---|---|---|---|
| Production Entry-Crusher | 781 | not yet screenshotted | — |
| Production Entry-Raw Meal | 777 | `CEMENT: Raw Meal Production` | `[WIP002] RAW MEAL` |
| Production Entry-Coal Mill | 778 | `CEMENT: Fine Coal Production` | `[WIP004] FINE COAL` |
| Production Entry-Clinker | 779 | `CEMENT: Clinker Production` | `[WIP003] CLINKER` |
| Production Entry-Cement | 780 | `CEMENT: Cement Production (CM1)` / `(CM2)` | `[FG001] CEMENT 42.5 R`, `[FG002] CEMENT 32.5`, `[FG005] CEMENT B-M 42.5 N` |

**Model name, from the URL (`model=custom.production.entry`): `custom.production.entry`.** This is a bespoke model, not standard Odoo Manufacturing (`mrp.production`) — record counts run from ~700–720 (Coal Mill, Raw Meal, Clinker) up to 6,106 for Cement, consistent with Cement logging two lines/day (CM1 + CM2) over a longer history.

### 2.1 Header fields (confirmed on list + form view)

| Field label | Example | Likely field name |
|---|---|---|
| Reference | `CEM/2026/02168` | `name` |
| Production Date | `11/09/2026` | unconfirmed |
| Picking Type | `CEMENT: Cement Production (CM1)` | `picking_type_id` |
| Product | `[FG001] CEMENT 42.5 R` | `product_id` |
| UoM | `MT` / `NOS` | `product_uom_id` |
| Produced Qty | `560.000` | unconfirmed |
| Status | Draft / Waiting For Approval / Approved | `state` |
| Approval Status | Waiting For First Approval / Approved | unconfirmed — appears to be a second, separate approval-workflow field |
| TPH | `70.00` (form view only) | unconfirmed |
| Total Input Qty | `571.648` (form view only) | unconfirmed |

### 2.2 Line-item fields ("Consumed Items" tab — one2many, form view only)

Observed on Cement record `CEM/2026/02168` (CM1, 42.5 R): lines for Clinker, Limestone Mining, LS2, Gypsum, Clinker SPG, Power Units CPP, Power Units TANESCO. Each row:

| Field | Example |
|---|---|
| Product | `[WIP003] CLINKER` |
| UoM | `MT` / `NOS` |
| Input Quantity | `443.408` |
| Stock Available | `1,463.970` |
| Moisture % | `10.00` |
| Final Qty After Moisture Correction | `443.408` |

This is the exact wet→dry correction the MIS's Raw Meal Material table currently does by hand (a typed wet weight × a typed moisture %) — Odoo is already computing it per entry, so this line is a direct source, not just a raw input.

There is also a second tab, **"History"**, contents unconfirmed.

**Open questions for you:**
- What is the one2many field name and target model for the Consumed Items line, and its own field names (product, input qty, moisture %, final qty)?
- Does the "History" tab hold anything the MIS would need (e.g. an edit audit trail, shift-level splits)?
- "Power Units CPP" / "Power Units TANESCO" appear as *consumed items* on a Cement Production entry (`UoM: NOS`, qty `21,800.000` in the screenshot) — is that actually a per-batch power reading? If so it may be a second, independent source for the MIS's `pwr_cm1_kwh`/`pwr_cm2_kwh` fields (currently 100% manual on a separate power-cons form) — worth a follow-up conversation once Production is wired up.

## 3. Field-level mapping: Odoo → MIS

What today's manual `daily-report.html` entry would stop needing, once each field below is confirmed.

### Cement Mill — Production Entry-Cement (CM1 / CM2)

| MIS fact key | Unit | Needs from Odoo |
|---|---|---|
| `cm1_425r_mt`, `cm1_425n_mt`, `cm1_325n_mt`, `cm1_opc_mt` | MT | Produced Qty, Picking Type = Cement Production (CM1), matched by Product grade |
| `cm2_425r_mt`, `cm2_425n_mt`, `cm2_425n_bm_mt`, `cm2_325n_mt` | MT | Same, Picking Type = (CM2) |
| `cm1_425r_cons_mt`, `cm1_325n_cons_mt`, `cm1_425n_cons_mt`, `cm1_opc_cons_mt`, `cm1_425n_bm_cons_mt` | MT | Consumed Items lines (clinker + gypsum + additives) for the matching batch |

**Discrepancy to flag with the Odoo team:** the screenshot shows Picking Type `(CM1)` producing product `[FG005] CEMENT B-M 42.5 N` (ref `CEM/2026/02170`, 144 MT) — but the MIS's fact keys only define `cm2_425n_bm_mt` (no `cm1_425n_bm_mt`). Either CM1 genuinely can produce that grade (in which case the MIS is missing a field) or "CM1"/"CM2" in Odoo's Picking Type doesn't map 1:1 to the physical mill the MIS field names assume. Needs confirming before this mapping is trusted.

### Kiln / Clinker — Production Entry-Clinker

| MIS fact key | Unit | Needs from Odoo |
|---|---|---|
| `kiln_prod_mt` | MT | Produced Qty, Picking Type = Clinker Production |
| `kiln_clinker_open` | MT | Opening stock — not visible on the list view; confirm whether this lives on the production entry itself or requires a separate stock-ledger query (the dashboard already reads Odoo's stock ledger directly for one KPI — see `forms/formula-registry.js`'s CM-1 despatch-day sourcing — so precedent exists either way) |

### Raw Meal / Raw Mill Material — Production Entry-Raw Meal

| MIS fact key | Unit | Needs from Odoo |
|---|---|---|
| `rmm_limestone_cons`, `rmm_clay_cons`, `rmm_ironore_cons`, `rmm_industrialclay_cons`, `rmm_bauxite_cons`, `rmm_milldustironore_cons` | MT | "Final Qty After Moisture Correction" on each Consumed Items line, matched by Product |
| `rmm_*_open` / `rmm_*_recv` / `rmm_*_closing` | MT | Stock movement — confirm source (production entry vs. separate stock query, same open question as Clinker above) |

### Coal Mill — Production Entry-Coal Mill

| MIS fact key | Unit | Needs from Odoo |
|---|---|---|
| `kiln_coal_cons` | MT | Fine Coal Produced Qty, or its Consumed Items line — need Odoo team to confirm which figure is the tonnage actually burned at the kiln |
| `cpp_coal_cons` | MT | Same question, CPP-bound coal, if Coal Mill output is split by destination |

### Crusher — Production Entry-Crusher

Not yet screenshotted. Needs the same header + Consumed Items capture as above before it can be mapped to MIS fields (likely `rmm_limestone_recv` / quarry-side receipt figures).

## 4. Two ways to deliver this — either works, your call

The MIS already has both patterns built and working against this Odoo instance.

### Option A — Generic Odoo External API (our preferred first choice)

`services/odooClient.js` already implements standard Odoo XML/JSON-RPC (`authenticate` + `execute_kw`/`search_read`) and is fully idle today — "not used by anything wired up yet." Since `custom.production.entry` is a normal model with a normal list/form view, a service-account user with **read access** to it is all that's needed — no new controller code on your side.

**What we need from you:**
1. A service-account Odoo user (or reuse of an existing API user) with read access to `custom.production.entry` and whatever model backs its Consumed Items lines.
2. Confirmation of exact field (technical) names for everything marked "unconfirmed" in §2–3 above.
3. `ODOO_URL`, `ODOO_DB`, a username and API key for that account — these slots already exist blank in our `.env` (`ODOO_URL`/`ODOO_DB`/`ODOO_USERNAME`/`ODOO_API_KEY`).

### Option B — A bespoke `production_report` controller (fallback, mirrors what you've already built four times)

If granting read access to the raw model isn't preferred, a `production_report` endpoint alongside your existing `dispatch_report` / `mining_report` / `sale_dashboard_report` / `purchase_dashboard_report` (same controller class, same opaque `api_key`, form-encoded POST, `from_date`/`to_date`) slots straight into our existing client pattern (`services/odooDispatchClient.js` is the template we'd copy).

If you go this route: please return **one row per production entry with its Consumed Items detail already attached** (nested, or a parallel table keyed by the same reference). A header-only feed still leaves us re-deriving moisture-corrected consumption by hand, which defeats the point of this request.

## 5. Requirements that apply either way

- **Filter out, or clearly flag, non-Approved records.** Row 2 of the Cement Production screenshot was `Status: Draft`, `Produced Qty: 0.000` — pulling that as-is would zero out a real day's production. We need either a server-side filter (`state = approved`), or the state/approval-status fields returned so we can filter client-side.
- **Strict ISO dates (`YYYY-MM-DD`).** Every connector we've built against this Odoo instance has hit the same trap: non-ISO date formats — including formats from your own team's documented examples — silently return zero rows or the wrong range instead of erroring.
- **Tell us the safe range per request, if there's a cap.** The sales/purchase dashboard endpoints truncate large ranges to unparseable JSON with HTTP 200 and no error — we only found this by testing. With ~6,100 Cement records already, `custom.production.entry` may hit the same wall; knowing the limit up front saves us re-discovering it.
- **A product-code dictionary**, if products come back as internal codes (`[WIP003]`, `[FG001]`, etc.) rather than a stable label. The mining integration hit exactly this — undocumented codes caused tickets to be silently mis-classified until we reverse-engineered a lookup table from another report. A code→grade mapping up front avoids repeating that.

## 6. Priority

**Raw Meal first** — it replaces the most tedious manual step (typing a wet weight, then a moisture %, that Odoo has already corrected) and was already an open item before this document. **Cement (CM1/CM2) second** — largest dataset, widest field coverage. **Clinker, Coal Mill, Crusher** can follow once the model/field names are confirmed from the first two.
