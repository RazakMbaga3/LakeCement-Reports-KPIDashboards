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
| WBS-DATA-3 | Odoo Phase 4 — move off the TEST instance onto production | Odoo Team (R-1) | 🔴 Blocked | `crit` once unblocked. Blocker is the *instance*, not the key |
| WBS-DATA-4 | Confirm Purchases category-grid field names, unstub `fetchCategoryGrid()` | Odoo Team (D-1) | 🔴 Blocked | |
| WBS-DATA-5 | Fix or retire `npm run odoo:test` so it reports per-connector health | — | 🟡 Open | RAID I-6 — currently misreports the live connectors as unconfigured |
| WBS-DATA-1 | Stoppage / Reliability report — close the deferred items | WBS-CODE-2 (to verify) | 🟡 Partial | Deferred: insights UI page, cost-of-stoppage (needs Finance TZS/hr rate), EN/SW labels |

## UI — UI/UX (`ui-ux-designer`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
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
| WBS-SEC-3 | Silence `dotenv`'s promotional log banners (`{ quiet: true }` or pin) | — | 🟡 Open | RAID I-11 |

## DEPLOY — Deployment (`deployment-engineer`)

| ID | Item | Depends on | Status | Notes |
|---|---|---|---|---|
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
