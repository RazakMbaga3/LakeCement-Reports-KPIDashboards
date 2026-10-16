# Work Breakdown Structure — Lake Cement Dashboard

IDs: `WBS-<WORKSTREAM>-<n>` (`CODE`, `DATA`, `UI`, `QA`, `SEC`, `DEPLOY`).
Every item names its owner, dependencies, and whether it sits on the
critical path. Seeded from `docs/PROGRESS.md`'s carried-forward open items
and `docs/TECHNICAL_SPEC.md` §12, then corrected against the six specialist
audits run 2026-09-13. Items reference `RAID_LOG.md` IDs where a risk or
issue drives them.

**Critical path right now runs through `WBS-CODE-2`** — the backend does not
boot, so no other item can be verified, let alone shipped.

## CODE — Code / Architecture (`code-architect`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
| **WBS-CODE-2** | **Restore backend boot — resolve the `pm`/`ei` dual ownership of `power-cons`** | **User decision: who approves power-cons** | **🔴 P0, critical path** | RAID I-3. Needs approval-ownership decided separately from submit access, or one role's claim reverted |
| WBS-CODE-3 | Add `audit_log` writes to `sales.js POST /targets` and `quarry.js POST /tickets/import` | — | 🟡 Open | RAID I-9 — both silently overwrite via `ON CONFLICT DO UPDATE` today |
| WBS-CODE-1 | Clear the 2 standing lint warnings | — | 🟡 Open | RAID R-5 |

## DATA — KPI / Data Reporting (`kpi-data-analyst`, stoppage work → `stoppage-report-designer`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
| WBS-DATA-2 | Quality KPI multi-month validation — build `verify-quality.py` | Source Excel access | 🟡 Open | RAID I-2. Every other KPI got 91/91-day verification; Quality got 1 day |
| WBS-DATA-3 | Odoo Phase 4 — move off the TEST instance onto production | Odoo Team (R-1) | 🔴 Blocked | `crit` once unblocked. Blocker is the *instance*, not the key. 2026-09-20: partly unblocked — production, sales and purchases answer on the production ERP; dispatch and mining are still test-only |
| WBS-DATA-4 | Confirm Purchases category-grid field names, unstub `fetchCategoryGrid()` | Odoo Team (D-1) | 🔴 Blocked | |
| WBS-DATA-7 | **Crusher TPH = production ÷ apron-feeder hours** (user decision 2026-10-15; old basis was running hours, new reads ~15–20% higher). Store `apron_feeder_hrs` from the production_report feed → fact `ls_crusher_apron_hrs` | — | 🟠 In progress (2026-10-15) | Check: 26-Sep 3,969.84 t ÷ 17.45 h = 227.5 t/h |
| WBS-DATA-8 | **CPP report autofilled from Odoo `cpp_entry`; overburden from Odoo Waste Material Entry; both + crusher TPH in the Daily MIS Mining section and the Quarry page** | WBS-DEPLOY-3 for production | 🟠 In progress (2026-10-15) | CPP: 4 core fields = plant Excel 77/77 days. Overburden tonnes = trips × 20 t (not weighed) |
| WBS-DATA-9 | **Production-report stock ledgers (opening/received/closing) + Coal for CPP**, rolled from the plant's 30-Jun closing with Odoo flows; nightly check against Odoo live stock; fix the MIS Stores-ledger stock lines (materials chain started from 0 on 31-Aug) | WBS-DEPLOY-3; Production/Stores answers (I-61) for limestone, clay, own clinker | 🟠 In progress (2026-10-15) | Replay Apr–Jun exact for 6 of 9 materials; 30-Jun→14-Oct lands exactly on Odoo live stock for coal/iron ore/bauxite/purch. clinker/fine coal |
| WBS-DATA-10 | **Production-report power row copied from the Electrical Power Consumption form** (Odoo has no meter data since Dec 2025) | Electrical resuming entry (I-62) | 🟠 In progress (2026-10-15) | 5 sections match 82–88/91 days; rm1/rm2/others/losses under investigation |
| WBS-DATA-11 | Quality report from Odoo lab entries (cement/clinker/kiln-feed/LS-pile/mined-LS sample analysis) — backfill to 30-Sep, live once the lab keeps entering in Odoo | WBS-DEPLOY-3 | ⚪ Planned | Verify cell-for-cell against the QC DAILY REPORT workbook first (I-2) |
| WBS-DATA-12 | Packing-plant stoppages from Odoo `packing_plant_stoppage_entry` (11k rows, current) into the stoppage report's packing section | WBS-DEPLOY-3 | ⚪ Planned | Delegate to `stoppage-report-designer`. Kiln/mill stoppages are NOT in Odoo |
| WBS-DATA-13 | Quarry stockyard stock (HG/LG/HGHMGO/clay) server-side | Plant opening balances | ⚪ Planned | Odoo's yard figures are not usable (LG1 566,428 t) |
| WBS-DATA-5 | Fix or retire `npm run odoo:test` so it reports per-connector health | — | 🟡 Open | RAID I-6 — currently misreports the live connectors as unconfigured |
| WBS-DATA-1 | Stoppage / Reliability report — close the deferred items | WBS-CODE-2 (to verify) | 🟡 Partial | Deferred: insights UI page, cost-of-stoppage (needs Finance TZS/hr rate), EN/SW labels |

## UI — UI/UX (`ui-ux-designer`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
| WBS-UI-3 | Clear `tbody.innerHTML` in `approvals.html`'s empty state (`load()`, line ~152) | — | 🟡 Open | RAID I-12 — stale approved row left in the DOM; the one real e2e failure that isn't external |
| WBS-UI-2 | Style `.kt-val.is-empty` on `daily-report.html` (rule exists only in unlinked `forms/forms.css`) | — | 🟡 Open | RAID I-8 — empty KPI values render as a solid navy bar |
| WBS-UI-1 | Close remaining `DESIGN_AUDIT_2026-09.md` §8 items | WBS-CODE-2 (audits need a live backend) | 🟡 Open | Confirmed still open: Quarry page weight (1616/1634KB vs 900KB budget — `quarry.js:94` still unpaginated), missing `scripts/validate_palette.js`, no dark mode, `.adm-btn` token drift. `form-materials` 34,000px height unverifiable while backend is down |

## QA — QA / Testing (`qa-test-engineer`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
| WBS-QA-2 | Unit-test the single-owner invariant in `approval.js` | WBS-CODE-2 | 🟡 Open | RAID I-5 — 9 suites went green while the app was unbootable; this class of failure must fail in tests, not at boot |
| WBS-QA-1 | Wire `e2e` + `audit:a11y`/`audit:responsive`/`audit:perf` into CI | WBS-CODE-2 | 🟡 Open | Only backend `npm test` + the ten `accept:*` suites are CI-gated today |
| WBS-QA-3 | Re-run the full gate table once the backend boots, and populate `DEFINITION_OF_DONE.md` with real evidence | WBS-CODE-2 | 🔴 Blocked | RAID I-4 — no DoD entry may be marked Done from evidence collected during this outage |

## SEC — Security / Performance (`security-performance-auditor`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
| WBS-SEC-1 | Verify and, if still default, rotate the `openpg` Postgres superuser password | Live DB access | 🔴 Blocked (needs a live check) | RAID R-4. `crit` for go-live. Not verifiable from the repo |
| WBS-SEC-2 | Set `DIGEST_TO`/`ALERT_TO` once Management names recipients | Management decision (D-2) | 🔴 Blocked | SMTP itself is fully configured — this is the only remaining email gap |
| **WBS-SEC-5** | **Fix the forgot-password address oracle** — wrap `mailer.js:38`'s send in try/catch so failures return `{sent:false}` instead of throwing a 500 | — | 🔴 **Open — security, live** | RAID R-7. Small fix; the intended behaviour is already written, it just never executes |
| WBS-SEC-3 | Silence `dotenv`'s promotional log banners (`{ quiet: true }` or pin) | — | 🟡 Open | RAID I-11 |

## DEPLOY — Deployment (`deployment-engineer`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
| WBS-DEPLOY-3 | **Connect the droplet to Odoo's database**: Odoo admin allows the droplet IP on 5432 and issues a narrower read-only login (I-60); set `ODOO_PG_*` in the droplet `.env`; `npm run odoo:db-test` there; confirm the new pulls go `ok` in `/api/health` | Odoo admin (I-60) | 🔴 Blocked on Odoo team | Every WBS-DATA-8/9/11/12 pull skips cleanly until this is done |
| WBS-DEPLOY-2 | Set `BACKUP_DIR`, run one backup + one `restore:drill`, record the evidence | — | 🟡 Open | RAID I-7 — no backups run locally today. Confirm the droplet's own backup state separately |
| WBS-DEPLOY-1 | Refresh `RUNBOOK.md`/`GO_LIVE_CHECKLIST.md` banners, then rewrite for the DigitalOcean path; fix the `npm ci` line in `DEPLOYMENT_DIGITALOCEAN.md:267` | — | 🟡 Open | RAID I-1, I-10 — banners still say the platform is "unconfirmed" 3+ weeks after it was decided |

## Dependency map (critical path)

```
WBS-CODE-2 (backend boots)  ──┬──> WBS-QA-3 (re-run all gates) ──> DoD entries can read Done
   ▲ needs your decision      ├──> WBS-UI-1  (audits need a live backend)
                              ├──> WBS-QA-1  (wire gates into CI)
                              └──> WBS-QA-2  (invariant test)

WBS-SEC-1 (openpg) ──> go-live          [needs live DB access]
WBS-DATA-3 (prod Odoo) ──> go-live      [blocked on Odoo Team]
WBS-SEC-2 (DIGEST_TO) ──> go-live       [blocked on Management]
```

Everything in the first cluster is gated on one decision from you. The three
go-live blockers below it are each owned outside this repo.
