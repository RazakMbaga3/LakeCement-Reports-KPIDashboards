# Raw Material Daily Report — Odoo Integration Plan

**Status date:** 2026-09-20 · **Owner:** you → Odoo team · **Evidence:** two Odoo exports of 2026-09-16
(`Gate Entry Report` 38 rows, `GRN Register` 67 rows, both "Filtered 14-09-2026 to 15-09-2026").
Every number below was computed from those files, not recalled.

## 1. What the two reports are

| | Gate Entry Report | GRN Register |
|---|---|---|
| Grain | one row per **truck visit** (physical) | one row per **truck receipt** (accounting) |
| Key | `Inward Token No` (RM/2026/03028) | `GRN No` (CM/GRN/2026/03402) + `Inward Token No` |
| Carries | gate in/out, gross/tare/**net weighbridge**, unloading start/end, driver, transporter, vendor (name only), challan qty, PO ref, and — once GRN'd — GRN no, cost/MT, PO qty + PO balance | PO, vendor (name **and code**), DC/invoice, challan/received/QC qty, bin, transporter, **freight/MT**, weighbridge net + ticket no, LC amount |
| Join | `GRN No` column links to the GRN row (34 of 38 tokens) | `Inward Token No` links back to the gate row |

The two files did not join in our sample (0 of 67 GRN tokens appear in the gate file). That is not a data
problem — the windows differ: the GRN file's coal trucks *entered the gate* 8–14 Sep, the gate file is 15 Sep only.

## 2. Findings that shape the design

1. **GRN lags the truck by 1.5 days on average (0.1–5.1 d).** A "received today" figure built from GRN date
   understates stock for days and then dumps it. The gate report is the timely source.
2. **"Pending GRN" is directly computable.** The materials form already has a `grn` (pending GRN) column.
   Tokens that exited with `GRN No` blank are exactly that: 4 of 38 on 15 Sep — 96.4 t coal + 33.4 t clay.
3. **GRN `Received Qty` is just the challan** — equal in 67/67 rows, QC rejected 0 in all. The *measured*
   quantity is the weighbridge net (in both files). `Variance Qty` = weighbridge − challan (verified);
   per-truck swings reach ±0.85 t. So "received" needs a definition (decision D1).
4. **The gate report's date filter looks wrong or exclusive.** "14 to 15 Sep" returned only 15 Sep tokens, yet
   the GRN register shows 18 coal trucks entering on 14 Sep. Same trap class as every other Odoo endpoint
   here — test the boundary before trusting any day total.
5. **15 Sep inbound, raw material only (35 trucks, 1,083.3 t):** coal 10 / 313.2 t, industrial clay 9 / 287.6 t,
   gypsum 8 / 243.5 t, iron ore 8 / 239.0 t. Three "Others" tokens (store materials, blank material code) are
   not raw material — filter on `Token Type = Raw Material`. Median gate turnaround 4.4 h, max 17.9 h.
6. **Cost is per PO, not per material.** Coal 100k/105k, gypsum 95k/120k/128k, iron ore 96k/108k TZS/MT on the
   same day. `config/materialRates.js` (empty: "no honest way to derive a rate") can be fed from here — but as a
   weighted actual per PO/period, not one flat rate. Freight (135k–193k TZS/MT) is separate and
   `LC Amount = qty × freight` in 67/67 rows, so landed cost is derivable.
7. **Mapping gaps on our side:**
   - Odoo item codes: COAL `RM000001`, GYPSUM `RM000003`, IRON ORE `RM000004`, INDUSTRIAL CLAY `RM000009`.
   - The Raw Material Report has **no Industrial Clay row** (only iron ore, gypsum, clinker + coal by supplier).
   - Coal is reported by *supplier row*; Odoo gives the vendor. Sample vendors map cleanly (Market Insight →
     `ck_market`, Jitegemee → `ck_jitegemee`, State Mining Corp → `ck_stamico`), but Odoo does not say
     **kiln vs CPP**, and the form has `cc_market`/`cc_stamico` receipt rows too (D2).
   - The gate report has vendor **name only** (GRN has the code). Names can be comma-joined on multi-vendor
     "Others" tokens; raw-material tokens are single-vendor.

## 3. Decisions needed from you

| # | Question | Recommendation |
|---|---|---|
| D1 | What is "received" on the daily report? | Weighbridge net, by the date unloading ended (physical, timely). GRN qty becomes the *pending-GRN* and reconciliation column, not `rcvd`. |
| D2 | Coal kiln vs CPP routing | A small vendor→row config (`config/odooMaterialMap.js`) that P&S owns; an unmapped vendor shows as "unassigned", never guessed. |
| D3 | Where do clay receipts go? | Add an Industrial Clay row (it sits with `rmm_industrialclay_*` in Raw Mill) — confirm with P&S. |
| D4 | Plant-day cut-off | Midnight, like the mining tickets — 2 of 38 trucks finished unloading after midnight. Confirm. |
| D5 | Auto-fill vs lock | Pre-fill and mark "Odoo" (third legend dot beside Manual/Formula); officer may override with a reason. |

## 4. Plan

**Phase 0 — Excel import (no Odoo dependency, ~2 days).** Same route the Quarry took before its API landed.
`POST /api/raw-material/import` accepts both exports (files are binary `.xls`; `exceljs` cannot read them —
add SheetJS `xlsx` to the backend). Migration `018`: `rm_gate_entries` (unique `inward_token_no`) and
`rm_grn_lines` (unique `grn_no`), each with `source 'excel'|'odoo'` (as in migration 016, so an upload and a
sync can never double count). Parser tested against these two files as fixtures. Gives history backfill and a
working pipeline the day the API arrives.

**Phase 1 — Odoo API request (parallel, owned by the Odoo team).** Ask for `gate_entry_report` and
`grn_register_report` beside the four existing endpoints on **production** (`erp.lakecement.co.tz` —
dispatch/mining still exist only on the test host). Same contract: form POST, `api_key`, ISO dates, plus:
one row per token/GRN with the columns above; **`token_status`, `cancel_reason` and `return_grn` included**
(cancelled/returned rows must not be silently summed); **vendor code on the gate report**; a stable unique key
per row; a documented date semantic per filter (`Token Date` for gate, `GRN Date` for GRN) that includes both
boundary days; a safe range cap. Before asking, capture the model names from dev mode (Technical → Models), as
we did for `custom.production.entry`, so read access via the generic External API is also on the table.

**Phase 2 — Sync (~2 days after the endpoint exists).** `odooRawMaterialClient.js` (copy
`odooMiningClient.js`), `odooRawMaterialSync.js` (upsert on natural key; re-pull a **rolling 7-day window
nightly** because GRNs land up to 5 days late and tokens change status after issue), a cron beside
digest/backup, an on-demand backfill script, and a result object that reports unmapped codes/vendors as the
mining sync does.

**Phase 3 — Wire the daily report (~3 days).** `GET /api/raw-material/daily?date=` returns per-row `rcvd`
(weighbridge net by unloading-end date) and `grn` (pending). `materials-form.html` pre-fills, tags "Odoo",
allows override-with-reason. `rcvd_mtd/ytd` become sums instead of typed. Closing-stock maths is untouched.

**Phase 4 — only after 0–3 are trusted.** Inbound-truck board on Purchases/Stores (trucks today, tonnes by
material, turnaround, pending-GRN ageing), vendor weighbridge-vs-challan variance, open PO balance per
material (already in the gate rows), weighted landed cost → `materialRates.js`. Each gets a tile only when real
data stands behind it.

## 5. Acceptance (boot-dependent gate, per DEFINITION_OF_DONE — not unit-green alone)

- Import of the two sample files yields 35 RM tokens / 1,083.3 t split as in §2.5, and 67 GRN rows / 2,135.48 t.
- Re-importing the same file changes nothing (idempotent); an Excel row and an Odoo row for the same token
  never both count.
- A token with `GRN No` blank appears in pending-GRN; when its GRN arrives the next sync clears it.
- A cancelled token contributes 0 t.
- The materials form for a synced date shows the Odoo values, on-screen tonnes equal the API total, and
  closing = open + rcvd − cons still holds.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Gate report date boundary (finding 4) silently drops a day | Boundary test in Phases 0/1; nightly re-pull window |
| Odoo endpoint truncates large ranges (HTTP 200, cut body) | Pull ≤ 7–14 days per call; sync fails loudly on a cut-off |
| Production vs test host mismatch | Name the host in the request; sync reports which host it read |
| Vendor spelling changes in Odoo | Map by vendor **code** (`CMLT0357`) — needs the code added to the gate report |
