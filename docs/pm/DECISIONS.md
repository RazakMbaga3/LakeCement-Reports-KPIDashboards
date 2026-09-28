# Decision Log — Lake Cement Dashboard

Append-only. Never edit or delete a past entry — a reversal is a new entry
that links back to the one it reverses. This is the single source of truth
for *why* things are the way they are, so a new session or a new person can
catch up fast without re-deriving history. Written only via the
`project-manager` skill's `decide` mode.

## Format

```
### DEC-### — <short title>
**Date:** <date>
**Decider (RACI Accountable):** <role/person>
**Context:** <what prompted this>
**Options considered:** <brief>
**Decision:** <what was decided>
**Consequences:** <what this changes — DoD/WBS/RACI cross-references>
```

---

### DEC-001 — Adopt cloud hosting via the Odoo team's DigitalOcean infrastructure
**Date:** (per `docs/TECHNICAL_SPEC.md` §10, date as recorded there)
**Decider (RACI Accountable):** Managing Director
**Context:** Original plan (`docs/RUNBOOK.md`) was an on-prem plant-LAN
Windows server deployment.
**Options considered:** On-prem Windows server vs. cloud hosting under the
Odoo team.
**Decision:** Production hosting moved to cloud infrastructure managed by
the Odoo team; `docs/RUNBOOK.md` superseded (banner added), `docs/
DEPLOYMENT_DIGITALOCEAN.md` is now the live deployment guide.
**Consequences:** `WBS-DEPLOY-1` (RUNBOOK rewrite) is low priority while the
banner points to `TECHNICAL_SPEC.md`; `deployment-engineer` treats
`RUNBOOK.md`/`GO_LIVE_CHECKLIST.md` as reference only.

### DEC-002 — Adopt this project-management system as the live source of truth
**Date:** 2026-09-13
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com)
**Context:** Project status was scattered across `docs/PROGRESS.md`,
`docs/TECHNICAL_SPEC.md`, and session memory — static and going stale.
Requested a standing PM/tech-lead/QA-lead system built on Claude Code's real
primitives (a skill + specialist subagents), auditing what's really built
rather than starting over.
**Options considered:** Keep updating `docs/PROGRESS.md` manually vs. build
a structured, evidence-gated system (`docs/pm/` + `.claude/skills/
project-manager` + six specialist agents).
**Decision:** Built the system described in `.claude/skills/
project-manager/SKILL.md`. `docs/PROGRESS.md` superseded (banner added,
kept as seed evidence) by `docs/pm/PROJECT_STATE.md`.
**Consequences:** All future status/DoD/RAID/RACI/schedule tracking happens
in `docs/pm/`; nothing is marked Done without a `validate`-mode evidence
citation.

### DEC-003 — E&I's HOD approves Power Consumption; approval ownership becomes explicit
**Date:** 2026-09-13
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com), on behalf of the Plant Head — access/RBAC policy is Accountable to the Plant Head per [`RACI.md`](RACI.md), so this should be confirmed with them.
**Context:** Commit `fa3d5ae` (2026-09-11) gave E&I submit rights on `power-cons` while P&M still held them. `middleware/approval.js` derives exactly one approving role per form type from the submit map and throws at module load on an overlap — so the backend stopped booting entirely (RAID I-3). Nine of ten acceptance suites, `access:matrix` and the whole e2e suite were blocked, while all ten unit suites still passed green.
**Options considered:** (a) P&M HOD approves, E&I submit-only; (b) **E&I HOD approves, P&M keeps submit**; (c) revert `fa3d5ae` and take E&I's access away again.
**Decision:** (b). Both departments keep submit rights; **E&I's HOD approves**, since E&I owns the kWh/meter readings being signed off. Approval ownership is now declared explicitly in `FORM_APPROVAL_OWNER` (`forms/access-registry.js`) rather than inferred from who can submit.
**Consequences:** Submitting and approving are now separate concepts in the access model. `approval.js` still throws on an *undeclared* overlap — the guard is intact, not removed, and `backend/test/approval-owner.test.js` proves it still fires. `docs/ACCESS_MODEL.md` updated, since it previously documented a single-owner model with no exception. Closes RAID I-3, I-4, I-5.

### DEC-004 — Packing Plant may submit Dispatch & SO; Logistics still approves it
**Date:** 2026-09-14
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com), on behalf of the Plant Head — access/RBAC policy is Accountable to the Plant Head per [`RACI.md`](RACI.md), so this should be confirmed with them.
**Context:** Packing Plant reported that the Dispatch & SO report (`forms/dispatch-form.html`) is the report they actually fill each day, but `dispatch` was owned solely by `logistics` in `FORM_ACCESS`, so the form was permanently view-only for them and never appeared in their Daily Reports nav. Same shape as DEC-003, and the second shared form type in the system.
**Options considered:** (a) **Packing submits, Logistics keeps submit + approval**; (b) Packing submits and Packing's HOD approves, moving sign-off off Logistics; (c) transfer `dispatch` to `packing` outright, taking it from Logistics.
**Decision:** (a). `packing` gains `dispatch` submit rights and the form in its nav; `logistics` keeps submit rights and remains the approver, declared in `FORM_APPROVAL_OWNER`. The ask was to let Packing *fill* the report, not to move sign-off, so no existing right is removed — and it leaves the author in one department and the approver in another, which is the Separation-of-Duties rule the access model already states. (b) is a one-line change to `FORM_APPROVAL_OWNER` if the Plant Head wants sign-off to follow the data.
**Consequences:** `dispatch` is now a shared form type, so the `approval.js` boot guard required a declared approver — supplied, and covered by a new assertion in `backend/test/approval-owner.test.js` so it can't regress the way DEC-003's overlap did. `GET /api/approvals` now scopes an HOD's queue by **who approves** (`OWNING_ROLE_BY_FORM_TYPE`) rather than by who may submit; it previously listed by submit rights, which since 2026-09-11 had been showing P&M's HOD `power-cons` reports that `requireApprover` 403s, and would have done the same to Packing's HOD for `dispatch`.

### DEC-005 — The Quality/Lab report is rebuilt from the plant's own QC workbook, and QC gets its own login
**Date:** 2026-09-22
**Decider (RACI Accountable):** You (razakmbaga3@gmail.com), on behalf of the Plant Head — access/RBAC policy is Accountable to the Plant Head per [`RACI.md`](RACI.md), so the access half of this should be confirmed with them.
**Context:** `forms/quality-form.html` was built from a mockup, not from the lab's sheet. Against the real *QC DAILY REPORT* workbook it carried fields the lab does not measure (Setting Time initial/final, 3-day strength, soundness, a per-grade free-lime column) while missing most of what it does: only one of three cement-mill sections, four of fourteen grade rows, no 1/2/7-day strengths, no L/C expansion, no coal proximate or calorific analysis, no RM-2 fineness, no clinker litre weight or Bogue phases. Blaine was declared in cm²/g where the workbook and the TBS requirement it prints ("380 to 410") are both in m²/kg. The lab also had no login of its own — only Production could file the report.
**Options considered:** (a) add the missing fields to the existing layout; (b) **rebuild each block around the workbook's own shape** — the grade × parameter matrix for physical tests, one day-average figure per parameter everywhere else — so an Excel drop fills the page; (c) keep the form as-is and import only the handful of fields the KPI registry needs.
**Decision:** (b), with four sub-calls:
  1. **Day averages replace the four-hourly sample columns** on Raw Mill, Kiln Feed and Clinker. The workbook still records four-hourly; `forms/excel-import.js` now averages those six rows into the one figure the form holds. The arithmetic moved to where the four-hourly data actually is.
  2. **Blaine is m²/kg**, and `blaine-425r` goes to v2 with a 380 target and the TBS 380–410 label. The same specification, in the plant's own unit.
  3. **`free_lime` moves to the Clinker block.** It was a row in the finished-cement table that the importer had always been filling from the *clinker* F.CaO average — same number, wrong section. `blaine_425r` and `strength_28d` keep their names, on Cement Mill-1's 42.5R row, because they are registry facts.
  4. **A `quality` role** (QC Manager + lab officers) may submit the three lab reports. Production keeps submit **and** sign-off on all three — same shape as DEC-004: nobody loses a right they had, and it puts author and approver in different departments, which the printed sign-off strip (Lab Analyst → QC Manager → Production Head) already describes.
**Consequences:** `quality`, `limestone` and `pile-quality` are now shared form types, so all three needed a declared approver in `FORM_APPROVAL_OWNER`; `backend/test/approval-owner.test.js` asserts it. The one Quality row that has ever existed — seeded by migration 015 — held mockup figures (Blaine 3680 against a real 358), which under the new unit would have read ten times high; migration `021_fix_apr21_quality_row.sql` replaces it with the genuine 21-Apr-2026 sheet, run through the same importer the QC manager's button uses. Two invented specs were removed rather than carried forward: fine-coal residue at 90µ was judged against a 5.0% limit the workbook does not state, while real day averages run 13–15%, so every day read HIGH; and the KPI strip opened showing 3.0% / 51.1% / 3,680 / 52.4 before any data had loaded. `KPI_EDIT_DEPTS.quality` is `[]` — the lab feeds Production's KPIs and owns no department section of its own.

### DEC-005 — Odoo's "CEMENT B-M 42.5 N" (Duramax 42 / FG005) IS the Dispatch report's 42.5 N B-M grade
**Date:** 2026-09-28
**Decider (RACI Accountable):** Plant Head, reported directly ("the 42.5 N B-M — also called Duramax — is always empty"), with the 27-Sept-2026 Dispatch Report workbook as the reference figure.
**Context:** Every 42.5 N B-M cell on the Dispatch & SO report had read empty since 2026-09-09. Odoo had the data all along: `services/odooDispatchSync.js` classified grade `CEMENT B-M 42.5 N` as UNMAPPED, so those rows were dropped with nothing but a `logger.warn` to show for it. The mapping had flipped twice — mapped to `dispatch_*_425nbm` on 2026-09-09, then un-mapped the same day on discovering the product is code FG005, marketed as "Duramax 42". The inference was that Duramax must therefore be a *different* product from the report's "42.5 N B-M" column, and that filing it there would misreport real tonnage. The reasoning was careful and the premise was wrong: they are one grade under two names — "Duramax" the marketing name, "42.5 N B-M" the plant's.
**Evidence:** (1) `config/odooProductionMap.js` has mapped `FG005 -> '425n_bm'` since it was written — the Production Report side of the app never disagreed; only the dispatch sync did. (2) Odoo's rows for 27 Sept are 150 MT (50 Kg Bag) and 89.58 MT (Bulker) under `CEMENT B-M 42.5 N`, against the workbook's 150 and 90 in the 42.5 N B-M column; the app's day total was short by exactly those two cells (2,639.3 vs 2,879).
**Options considered:** (a) **map `CEMENT B-M 42.5 N` -> `425nbm`**; (b) add a separate Duramax column to the Dispatch form, keeping the two grades distinct; (c) leave unmapped and have the plant key B-M in by hand.
**Decision:** (a). (b) was the plan recorded in the old code comment, and it would have built a column for a product that does not separately exist. (c) asks the plant to re-type data the ERP already holds.
**Consequences:** Backfilled 2026-03-01..2026-09-28 (208 days, 1,120 rows, **0 unmapped**). Sept MTD now reconciles to the workbook column by column — Regular Bags B-M 5,213 and Bulker B-M 3,451 both exact, 27 Sept day total 2,878.9 vs 2,879. The data loss ran **19 days undetected across 172 affected days / ~52,657 MT** because an unmapped row is invisible outside a log line nobody reads. Two consequent changes: `FLY ASH` and `VEHICLE SOLD` join `SCRAP STEEL` as explicitly SKIPPED non-cement, so the unmapped bucket goes quiet and can work as an alarm again; and `backend/test/odoo-dispatch-map.test.js` (new, wired into `npm test`) pins the whole mapping against the real 27-Sept figures — this sync had **no test at all**, which is how a mapping this consequential flipped twice unnoticed. Big Bag cement stays deliberately unmapped: the channel now exists in Odoo but has only ever carried fly ash.
**Follow-up:** Bulker 32.5 N reads 425 MT against the workbook's 395 for Sept MTD — a 30 MT gap unrelated to this fix, in the one grade whose Odoo label (`CEMENT 32.5`, no N/R suffix) was always an assumed match. Worth a look with the Odoo team; every other column is exact.

### DEC-006 — A target nobody set is not a target: remove the Dispatch form's invented defaults
**Date:** 2026-09-28
**Decider (RACI Accountable):** Plant Head (reporting standards).
**Context:** The Dispatch review page showed "MTD vs Monthly Plan **423.7%**" against a "Plan 10,200 MT". September's real dispatch was 51,507 MT. The 10,200 came from `data-default="10200"` hardcoded on the plan input in `forms/dispatch-form.html` — **no plant plan was ever entered, and `dispatch_mtd_target` has never been stored in a single report.** `dispatch.html` is careful and says "No monthly plan entered on the report" when the field is empty; the default is precisely what stopped that honest fallback from ever firing. Two further inputs in the Bags Packed table (`data-default="7000"` and `"600"`, the "Target / Day" column) had **no `data-field` at all** — they rendered, accepted typing, and were discarded on submit, the same defect the plan row's own comment says was cleaned out in 2026-09-15 but which these two escaped.
**Options considered:** (a) **remove the defaults and let the card say no plan is set**; (b) keep 10,200 and treat it as provisional; (c) guess a realistic plan (~55,000 MT) and hardcode that instead.
**Decision:** (a). (c) is the same defect with a more convincing number — the point is that a figure the plant never chose must not be presented to the plant as its own target. The plan input keeps a `placeholder` (a hint, never submitted); the two orphan target cells become read-only text showing the standing 7,000/600 figures, which are properly declared in `forms/formula-registry.js` (`bags-packed`, target 7000) where the review page actually reads them.
**Consequences:** Until someone enters a real monthly plan, the card reads "No monthly plan entered on the report" instead of a flattering 423.7%. That is the correct state. No stored data changes — there was none to change.

### DEC-007 — Odoo-synced dispatch days are drafts, not pre-approved reports
**Date:** 2026-09-28
**Decider (RACI Accountable):** Plant Head, on the Packing Plant's behalf.
**Context:** SO Pendency, Bags Packed, Burst Bag Rate and the 8 AM vehicle queue read "No data" on every date. These are counted by the packing plant and can only be typed in — Odoo has no source for them. The cause was two individually-sound decisions colliding: `odooDispatchSync.js` inserted every day it pulled as **`approved`** (reasoning that an ERP figure is reported data, not a draft, and that a draft would be invisible to the KPI engine per `REPORTED_STATUSES`), while the write-lock added 2026-09-24 refuses any submit over a report that is `approved` **or** `pending_approval` (`routes/reports.js:285`, code `REPORT_LOCKED`). Because the sync touches every dispatch date, it had pre-approved **all 208 stored days — 208 of 208 locked, 0 writable.** The four empty cards were not a data-entry omission; entry was impossible. Confirmed: **zero** dispatch rows have ever had a human submitter, approver or editor.
**Options considered:** (a) **insert untouched days as `draft`**, matching `odooProductionAutofill.js`; (b) insert as `pending_approval` — rejected on evidence: it is in the lock predicate too, so it does not unlock anything (this was tried first, as migration 029, and verified not to work before being corrected); (c) exempt the sync's own rows from the write-lock — a second, parallel rule; (d) add `draft` to `REPORTED_STATUSES` so drafts count — silently re-reports half-empty days.
**Decision:** (a). It is the answer decision B (2026-09-21) already reached for the Production autofill, so the codebase keeps **one** autofill workflow rather than two: a day Odoo has data for, that nobody has touched, is a draft the officer opens, completes and submits through the normal HOD step.
**Consequences:** Migrations `029` then `030` moved the 208 stored days to `draft` (both re-assert per row that `approved_by`/`submitted_by`/`updated_by` are NULL, so any day a person had signed would be left alone — none had). **Known, deliberate cost:** `draft` is outside `REPORTED_STATUSES`, so a dispatch day now counts in the KPI engine, the MIS pack and Entry Completeness only once an officer submits it — the same bargain Production already makes, and the honest one against a report that claims to be signed off while half of it was never filled. **Operational follow-up: the Packing Plant now has ~208 draft dispatch days to work through; only recent ones are likely worth completing, and the rest can be left as the ERP record they are.** `backend/test/odoo-dispatch-map.test.js` reads the lock predicate out of `routes/reports.js` rather than restating it, so the two cannot drift back into conflict silently; `e2e/tests/dispatch-manual-entry.spec.js` proves a packing officer can now save all four cards' fields and that the old `approved` state produced an unclearable 409.

---

_Further decisions (RACI names confirmed, WBS priority calls, DoD criteria
changes) get appended here as they're made._
