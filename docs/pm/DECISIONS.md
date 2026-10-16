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

### DEC-008 — The write-lock protects a human signature, not a status
**Date:** 2026-10-01
**Decider (RACI Accountable):** Plant Head — "need it to be live, remove the draft and approval issue, so long as we are pulling from Odoo all the info in Odoo is already approved."
**Context:** DEC-007 (2026-09-28) made the Odoo dispatch sync write `draft` so the packing plant could enter the half of the Dispatch & SO report Odoo cannot supply. It fixed data entry and **broke the dashboard**: `draft` is outside `REPORTED_STATUSES`, so `dispatch.html` counted no day at all and showed *"A draft exists for 01 Sept 2026, but it has not been submitted"* on all **211** stored dates. Management could not read the report at all. I introduced that regression; this reverses it without reintroducing the lockout it was solving.
**Root cause:** both failures came from one wrong assumption — that `status` records whether a report has been signed. It does not; **`approved_by`** does. An Odoo row carries `status='approved'` to mean "this is ERP fact, not somebody's unfinished typing", with `approved_by IS NULL` because no person signed it. The write-lock (added 2026-09-24) read only `status`, so it treated the robot's statement of fact as a human signature to defend — locking the form on every date. The lock's own comment already said its purpose was to protect a human's approval; it just wasn't testing for one.
**Options considered:** (a) **lock on `approved_by`, sync writes `approved`**; (b) keep `draft` and add `draft` to `REPORTED_STATUSES` — silently re-reports genuinely unfinished human drafts across every form; (c) keep `draft` and special-case dispatch in `dispatch.html` — a second visibility rule, diverging from `config/forms.js`; (d) exempt the sync's rows from the lock by caller identity — a parallel permission rule.
**Decision:** (a). `routes/reports.js` now computes `humanSigned = !!prior.approved_by` and only locks when that is true. The sync is back to `approved`, which is simply what is true of the data. **The two goals were never actually in conflict** — the dashboard reads live AND the packing plant can still add SO Pendency, Bags Packed, Burst Bag Rate and the 8 AM vehicle queue on top.
**Consequences:** Migration `032` returns the 211 stored days to `approved` (re-asserting per row that `approved_by`/`submitted_by`/`updated_by` are NULL, so any day a person has since touched is left alone). Verified: 1 Sept now reports **1,721.6 MT** instead of the empty-state panel, and all 26 September days count (**59,579 MT** MTD). A day a **person** approves still locks exactly as before — that is the case the rule was written for, and it is unchanged. Note this makes the lock's behaviour depend on `approved_by` across **every** form type, not just dispatch; for human-submitted reports the two always move together, so nothing changes there. `backend/test/odoo-dispatch-map.test.js` now pins both halves (verified to fail when the `humanSigned` condition is removed) and `e2e/tests/dispatch-manual-entry.spec.js` proves the pair directly: an ERP-approved day is writable, a human-approved day returns 409.
**Supersedes:** DEC-007's status choice. Its diagnosis of the lockout stands; only the remedy changed.

### DEC-009 — Compliance Master: one register, three kinds of obligation, status computed from the dates
**Date:** 2026-10-12
**Decider (RACI Accountable):** You (sole developer / PM), answering the planning questions directly.
**Context:** `1. Compliance Master.xlsx` held about 204 obligations in three different shapes: licences and certificates with Valid From/To, recurring filings and payments with rules like "20th every month", and the mining-lease conditions ("maintain 200 m…"). Its Status column was typed by hand and had drifted. As of 2026-10-12, 96 of the 106 dated rows were past their own "To" date and 66 of those still said "Active".
**Options considered:** (a) **track all three kinds**; (b) licences plus filings only; (c) licences only.
**Decision:** (a), with **status never stored**. `backend/services/complianceStatus.js` computes Active / Due / Overdue / No date set / Inactive from the dates on every read, so the dashboard, register, reminder emails and KPI hint cannot disagree. "No date set" is its own bucket, so a data gap is never presented as a verdict.
**Consequences:** Migrations 037/038, `routes/compliance.js`, `compliance.html`; guide in `docs/COMPLIANCE_MASTER.md`. Recurring instances live in `compliance_periods`. A missed instance stays open, so the record stays Overdue until it is filed or waived.

### DEC-010 — The "Head" reminder tier is one central list, kept by the MD
**Date:** 2026-10-12
**Decider (RACI Accountable):** You.
**Context:** The workbook's reminder columns have three tiers (Direct / 2nd Level / Head). Its Level 2 is already mostly a department head: Pavan Gandhi on 87 rows, Sankalp on 38, Sajivkumar PS on 20.
**Options considered:** (a) **one central configurable escalation list**; (b) each department's HOD; (c) a third named person on every record.
**Decision:** (a). The list is set in Settings & people, and the MD (and admin) maintain it.
**Consequences:** `compliance_head_recipients`. The list is added at the third reminder day and on every overdue reminder.

### DEC-011 — Each department owns its own compliance records; admin may edit but never verify
**Date:** 2026-10-12
**Decider (RACI Accountable):** You.
**Options considered:** (a) a central Compliance Officer role plus department owners; (b) the central officer only; (c) **each department owns its own**.
**Decision:** (c). `owner_role` is the boundary, and a record outside the caller's department answers 404. md/management read every department and write nothing. Within a department, officers record work (certificates, filings, reviews), seniors edit and verify, and HODs archive and transfer. Admin may fix data and import, but **cannot verify**: verifying attests a department's facts (Separation of Duties). Admin-type workbook sections (Corporate - Admin, Admin/Safety, Training) belong to HR & Admin.
**Consequences:** `backend/config/complianceAccess.js`. The matrix is in `docs/ACCESS_MODEL.md`. `quality` was added to `config/orgCatalogue.js` ROLES, where it had been missing.

### DEC-012 — Import honestly: every imported record is unverified and its reminders are held
**Date:** 2026-10-12
**Decider (RACI Accountable):** You.
**Options considered:** (a) **import as computed + unverified + held reminders + a "% verified" figure**; (b) a separate "needs verification" status; (c) clean the Excel first.
**Decision:** (a). Day one shows the truth (101 Overdue), the import preview shows "Sheet said" next to "Computed now", and no reminder email goes out for a record its department has not confirmed.
**Consequences:** A verification drive is the first go-live step (R-8). Re-import never overwrites a record edited or verified in the app, and never deletes.

### DEC-013 — Compliance documents are stored in Postgres (bytea)
**Date:** 2026-10-12
**Decider (RACI Accountable):** You.
**Context:** No file storage existed in the app. The nginx web root is the git checkout, which on the same day was found serving `.env` and `.git` (RAID I-42).
**Options considered:** (a) **bytea in Postgres**, deduplicated by sha256; (b) a directory outside the checkout, served through an authenticated route.
**Decision:** (a). pg_dump and the monthly restore drill already cover the database, and the drill now re-hashes the newest blob. Nothing sits under the web root, and a document row can never point at a missing file.
**Consequences:** Volume is about 100–200 MB a year. Revisit at about 2 GB, or if backup time doubles; the separate `compliance_blobs` table keeps a move to object storage local. Uploads are capped at 10 MB, type-checked against the file's magic bytes, and limited to two in flight.

### DEC-014 — Reminders go through the existing Graph mailer, exactly once, and start switched off
**Date:** 2026-10-12
**Decider (RACI Accountable):** You.
**Decision:** The reminder job calls `mailer.sendMail` (Microsoft Graph, R-6 closed) with the sender name "Compliance Master System". The outbox `compliance_notifications` is keyed (item, deadline, stage, recipient), so each reminder is sent once however often the job runs (07:00 and 14:00 Africa/Dar_es_Salaam, never at boot).
- There is one consolidated email per person per run.
- Held, no-email and switched-off reminders are recorded with their reason and released when the reason clears.
- The in-app master switch defaults **off**.
**Consequences:** `GET /api/health` → `checks.compliance`. Each run records its duration and heap delta. On the real 203-record data set a run takes about 0.3 s.

### DEC-012 — A machine-filled report is 'approved' with no signature; it never queues for one
**Date:** 2026-10-14
**Decider (RACI Accountable):** Razak (asked for approval to be removed for Odoo-filled reports); implemented by `code-architect`.
**Context:** the Approvals queue held **143 reports and every one was machine-filled — zero human submissions** (99 production + 44 materials; measured 2026-10-14, and still growing: it was 145 twenty minutes later). HODs were being asked to sign off days no person wrote. It had already caused a real failure: an officer's CPP report was reported "missing" because it was row 138 of 138 (RAID I-44/I-48). A queue that is 100% noise trains approvers to ignore it, which destroys the control.
**Root cause:** decision B′ (2026-10-07) had `odooProductionAutofill.js` and `odooMaterialsAutofill.js` create new days as `pending_approval`. B′ was right that the day must COUNT — `draft` is outside `REPORTED_STATUSES` and had left the Production Report reading "No data" over real tonnage — and wrong about where to park it. These writers walk **every** day Odoo has, so the queue necessarily fills with their rows.
**Options considered:** (a) a new distinct status for machine-filled rows — rejected: a new value is outside `REPORTED_STATUSES`, so every KPI would blank unless it were added, and ~20 files branch on status; large blast radius for no gain. (b) keep `pending_approval` and filter `submitted_by IS NULL` out of the approvals queue — rejected as the primary fix: it hides the symptom while leaving the rows permanently "awaiting a signature" that is never coming, and any future queue, count or report must remember to repeat the filter. (c) auto-approve with a synthetic system actor in `approved_by` — **rejected, and it would have been actively harmful**: `approved_by` is the column DEC-008 made load-bearing as "a human signed this", so a fake id would re-lock every Odoo day and recreate the exact dispatch lockout DEC-008 fixed, as well as lying in the audit trail. (d) **`approved` with `approved_by` left NULL** — chosen.
**Decision:** (d). Both autofill writers now create `status='approved', approved_by=NULL`. This is **not a new convention** — it is exactly the shape `odooDispatchSync.js` has used since DEC-008, now applied consistently to the other two machine writers. The status describes the **data** ("Odoo's own people approved this before the API returned it"); the NULL `approved_by` describes the **signature** (there isn't one).
**Why it is safe:** `REPORTED_STATUSES = ['approved','pending_approval']` (`backend/config/forms.js:37`) — both already count, so no dashboard figure moves. Proven, not assumed: with report data held constant inside a rolled-back transaction, flipping all 145 rows between the two statuses changed **0 of 7,296** daily (day × formula) evaluations and **0 of 320** monthly aggregates.
**What is deliberately NOT changed:** nothing sets `approved_by`, so the write-lock's `humanSigned` test (DEC-008, `backend/routes/reports.js:300`) is untouched and the meaning of "approved" for a **human-signed** report is not widened. The 77 human-signed reports still lock exactly as before. The audit trail still identifies these rows as machine-filled: each carries an `ODOO_AUTOFILL` row in `report_revisions` with `actor_id` NULL and `actor_name` `'odoo-sync'` (284 such rows), and `approved_by`/`submitted_by` stay NULL. An HOD who wants to review or correct an Odoo day still can, directly.
**Consequences:** migration **039** moved the 145 existing rows (guarded per row on `approved_by`/`submitted_by`/`updated_by`/`rejected_by` all NULL, so any day a person had touched was left alone; reversal SQL is in the file). The approvals queue is now **empty**, so the next real human submission is item #1. `scripts/queue-production-backlog.js` is marked SPENT — re-running it would re-flood the queue. Four stale assertions (2 in `accept:amendments`, 2 in `accept:odoo-production-autofill`) that encoded the pre-DEC-008 rule were updated; both suites are now 92/92 and 24/24.
**Follow-on defect found and fixed (see I-49):** `forms/form-persist.js` locked the form on **status alone** and never read `approved_by`, so it disagreed with the server — it greyed out every unsigned day and pushed people into a correction request for an edit the server would simply have accepted.

---

_Further decisions (RACI names confirmed, WBS priority calls, DoD criteria
changes) get appended here as they're made._
