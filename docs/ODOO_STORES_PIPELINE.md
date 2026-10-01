# Odoo Stores Pipeline — Gate Entry, GRN Register, Material Issues

**Live since:** 2026-10-01 · **Replaces:** three manual `.xls` downloads + hand pivots

Until now the Raw Material Report and the Diesel Consumption Report were
built by an officer opening Odoo, running three report wizards, downloading
the `.xls`, and pivoting the rows in Excel. The Odoo team exposed those same
three wizards as API endpoints on 2026-10-01. This is the pipeline that
reads them.

---

## 1. The three endpoints

All on the production ERP (`erp.lakecement.co.tz`), same transport as the
five bespoke endpoints already in use: **form-encoded POST**, not JSON.

| Endpoint | Odoo model | Grain | Feeds |
|---|---|---|---|
| `gate_entry_report` | gate token | one row per **truck visit** | received tonnage, pending GRN |
| `grn_register_report` | `purchase.order` | one row per **GRN line** | valuation (rate × qty), landed cost |
| `material_request_report` | `material.request` | one row per **issue line** | diesel + all store consumption |

### Measured behaviour (2026-10-01, production)

| Call | Window | Time | Size |
|---|---|---|---|
| `material_request_report` | 2 days | 2.4 s | 245 KB |
| `grn_register_report` | 2 days | 4.4 s | 242 KB |
| `gate_entry_report` | 2 days | 15.0 s | 220 KB |
| `grn_register_report` | 1 month | 40–55 s | 2.5 MB |
| `gate_entry_report` | 1 month | **timed out at 180 s** | — |

**This is why it is a scheduled sync, not a read-through.** Nothing in that
range can sit in front of a page load.

### Differences from the older endpoints

1. **Both date formats work.** The Odoo team's example used `DD-MM-YYYY`;
   the five older endpoints reject anything but ISO. These accept either and
   return identical results (1,869 rows for the same Feb window in both
   spellings). We send ISO only — one spelling everywhere beats relying on a
   tolerance that may not survive a deploy.
2. **Flat array under `data`**, not the named-arrays bundle
   `purchase_dashboard_report` returns.
3. **Single-day windows include that day.** The UI's gate-entry export had an
   off-by-one that dropped the start day; the API does not.

---

## 2. Verification against the manual exports

Every number was replayed against the `.xls` files the officers downloaded
by hand on 2026-09-16, not merely smoke-tested:

| Check | Manual export | API / pipeline |
|---|---|---|
| GRN COAL, 14–15 Sep | 67 rows, 2,135.48 MT | **67 rows, 2,135.48 MT** |
| Row `CM/GRN/2026/03402` | challan 32.14, variance −0.36, freight 170,000, LC 5,463,800, WB 31,780 | **identical, field for field** |
| Diesel, 15 Sep (CEMENT) | 10 rows, 4,425 LTR | **10 rows, 4,425 LTR** |
| Receipts, 15 Sep | clay 287.6 / gypsum 243.5 / iron ore 239.0 MT | **287.62 / 243.52 / 239.02** |

---

## 3. Decisions baked into the pipeline

### "Received" is the gate, not the GRN

GRN is booked **0.1–5.1 days after the truck arrives** (mean 1.5), measured
over the 2026-09-16 sample. A "received today" figure built from `grn_date`
understates stock for days, then dumps a backlog into one day.

So `receipt_date` is derived from the gate entry's **unloading-end time**,
and the gap between the two is reported in its own right as **pending GRN**.
The rolling re-pull window is **7 days** for exactly this reason: a day's
rows are not final when that day ends.

### Timestamps are plant-local (UTC+3)

Odoo sends `DD/MM/YYYY HH:mm:ss` wall-clock, with no zone. Parsed as UTC, a
23:56 unloading on 15 Sep lands on the 16th and moves a truck to the wrong
stock day — a real value in the sample. Anchored to `+03:00`.

### Odoo comma-joins fields on multi-vendor tokens

On an "Others" token several values are joined into one field: `vendor`
reached **154 chars**, `grn_no` 93, `po_ref` 88, and `grn_date` arrives as
`"16/09/2026, 16/09/2026, 15/09/2026, …"`. The first sync run died on
`VARCHAR(40)`. Those columns are `TEXT`, the date parser takes the first
date rather than returning null for the whole row, and `vendorCode()`
returns **null** for multi-vendor rather than labelling a truck with one of
its several suppliers.

### Raw material has no PR step — this is not a missing field

Measured over 181 GRN lines:

| Item | Lines with a PR |
|---|---|
| COAL | 0 / 67 |
| IRON ORE | 0 / 53 |
| GYPSUM | 0 / 26 |
| INDUSTRIAL CLAY | 0 / 11 |
| Store items (cable, tape, felt, rope, gear oil) | **15 / 15** |

Raw material goes straight to PO. The `pr_no` column is kept for the
store-item side. **Do not re-ask the Odoo team to "fix" this.**

### Coal Kiln vs CPP cannot be read from receipt data

The Raw Material Report splits coal into `COAL-KILN` and `COAL-CPP` by
supplier. Odoo cannot tell us which: **all 67 coal lines share
`location_and_bin = 'COAL YARD-OPEN YARD'`**. There is no destination field,
because the split happens later, when coal is drawn from the yard.

`backend/config/odooMaterialMap.js` maps each vendor code to the standing
arrangement for that supplier. Anything unmapped is reported as
**Unassigned**, with its tonnage and vendor code visible, and is never
folded into a mapped row to make a total look complete.

**To add a supplier:** add its vendor **code** (not name — names change
spelling in Odoo) to `COAL_VENDORS`.

---

## 4. Where it lives

| Layer | File |
|---|---|
| Schema | `backend/db/migrations/031_odoo_stores_tables.sql` |
| Client | `backend/services/odooStoresClient.js` |
| Sync | `backend/services/odooStoresSync.js` |
| Mapping | `backend/config/odooMaterialMap.js` |
| Report queries | `backend/services/storesReport.js` |
| Routes | `backend/routes/stores.js` |
| Schedule | `backend/services/odooSync.js` → pull `stores-gate-grn-issues` |
| Browser tests | `e2e/tests/stores-odoo-feed.spec.js` |

### Tables

- `rm_gate_entries` — one row per truck visit, keyed on `inward_token_no`
- `rm_grn_lines` — one row per GRN line, keyed on `(grn_no, item_code, line_seq)`
- `stores_issues` — one row per issue line, keyed on `(issue_no, line_seq)`

Each carries `source` (`'odoo'` | `'excel'`). **The sync never overwrites an
`'excel'` row** — a manual upload is an operator's deliberate act.

### Endpoints

| Route | Who |
|---|---|
| `GET /api/stores/raw-material?date=` | RAWMAT ∪ PURCHASE view roles |
| `GET /api/stores/issues?date=&product=` | same |
| `GET /api/stores/valuation?from=&to=` | same |
| `GET /api/stores/freshness` | same |
| `POST /api/stores/sync` | admin / md / stores only |

The read gate is the **union** of `RAWMAT_VIEW_ROLES` and
`PURCHASE_VIEW_ROLES`. Gating on RAWMAT alone left the `purchase` role — the
department that raises the POs — looking at three permanently empty tables
on its own dashboard. Caught by the e2e spec, not in review.

`POST /sync` holds a **process-wide in-flight lock**: two officers pressing
Refresh would otherwise put two 15–55 s pulls on an ERP that also serves the
plant's own Odoo users. It returns **207** when some datasets succeeded and
some failed, so a partial result is never mistaken for a complete one.

### Configuration

Normally **nothing to set** — all three URLs derive from
`ODOO_PRODUCTION_URL` by swapping the report name, reusing
`ODOO_PRODUCTION_API_KEY`. Override per-endpoint only if one ever moves
host: `ODOO_GATE_ENTRY_URL`, `ODOO_GRN_REGISTER_URL`,
`ODOO_MATERIAL_ISSUE_URL` (+ `_API_KEY` each).

The scheduled pull runs under `ODOO_SYNC_CRON`, which **`.env.example`
ships as `off`**. A droplet built from that file will not sync until it is
set.

---

## 5. Still open

- **Coal vendor mapping is incomplete.** Only the three suppliers seen in
  production data so far are mapped. The form has ~24 coal rows, most
  dormant. A new supplier appears as Unassigned with its code — that is the
  prompt to add it, and is working as intended.
- **Opening stock and consumption remain manual.** Odoo knows what arrived
  and what was issued from the store; it does not know yesterday's closing
  pile or what the kiln burned. Those stay the officer's figures.
- **No pagination upstream.** A month of gate entries still times out, so
  the sync pulls a 7-day window. Requested from the Odoo team.
