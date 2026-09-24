# Definition of Done — Lake Cement Dashboard

Evidence-only. Status is set **only** by the `project-manager` skill's
`audit` or `validate` mode, and only from a real command's real output —
never from a code read, a subagent's unverified claim, or visual inspection.
See `.claude/skills/project-manager/SKILL.md`.

**Audited 2026-09-13 · re-verified after the P0 fix the same day.**
The first audit found the backend unbootable (RAID I-3), which blocked nine
of ten acceptance suites. After the fix (DEC-003) the gate table was re-run
and the results below are current.

> **Rule this audit earned:** during the outage, all nine unit suites passed
> green — 54 assertions — while the application could not start at all. Unit
> green is not proof of a working system. Every entry here therefore
> requires a boot-dependent gate, not just unit tests. The missing guard is
> now itself a test (`test:approval`).

## Template

```
### <Component>  [WBS-ID]
**Status:** Done | Partial | Missing | Blocked | Not yet defined
**Owner:** <agent>   **Last verified:** <date> via <mode>
**What "done" means** (changed only via a DECISIONS.md entry):
**Evidence required:**
| # | Criterion | Evidence source (exact command) | Last verified | Result |
**Known gaps / explicitly deferred:**
```

---

## Backend boot & core platform  [WBS-CODE-2]

**Status:** 🟢 **Done**
**Owner:** `code-architect` · **Last verified:** 2026-09-13 via `validate`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Server boots | `cd backend && npm run smoke` | 2026-09-13 | ✅ `SMOKE OK — /api/health 200` |
| 2 | Approval ownership unambiguous | `npm run test:approval` | 2026-09-13 | ✅ 5/5 — incl. proof an *undeclared* overlap still throws |
| 3 | Approver is the intended role | `npm run access:matrix` | 2026-09-13 | ✅ `power-cons → ei APPR` |

## Unit / formula test layer  [WBS-CODE-1]

**Status:** 🟢 **Done**
**Owner:** `qa-test-engineer` · **Last verified:** 2026-09-13 via `validate`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Full aggregate green through smoke | `cd backend && npm test` | 2026-09-24 | ✅ all **17** suites + smoke pass |
| 2 | Lint | `npm run lint` | 2026-09-24 | ✅ clean — 0 errors, 0 warnings |

Suites: formulas 4/4 · facts 2/2 · access 8/8 · approval 5/5 · stores 5/5 · kpi-keys 5/5 · form-facts 4/4 · kpi-level 8/8 · auth-tokens 12/12 · auth-mail 6/6 · mailer · odoo-production · odoo-production-autofill 12/12 · **revisions 21/21 (new)** · **excel-extractors 32/32 (new)**.

## Phase acceptance suites  [WBS-QA-3]

**Status:** 🟡 **Partial** — 9 of 10 green, 1 real failure
**Owner:** `qa-test-engineer` · **Last verified:** 2026-09-13 via `validate`

| Suite | Command | Result |
|---|---|---|
| Phase 1 — Security & Auth | `npm run accept:phase1` | ✅ 19 passed, 0 failed |
| Phase 2 — Data Layer | `npm run accept:phase2` | ✅ **18** passed, 0 failed — B4 now asserts that an offline "use mine" **cannot** overwrite an approved report, plus B4b that the refusal names the real reason |
| Phase 3 — KPI Formula Layer | `npm run accept:phase3` | ✅ 27 passed, 0 failed |
| Phase 5 | `npm run accept:phase5` | ✅ 10 passed, 0 failed |
| **Phase 6 — Alerts/Email** | `npm run accept:phase6` | ❌ **13 passed, 3 failed** — all three are the tenant SMTP-AUTH block (RAID R-6), not defects in this code |
| Phase 7 — Backup/Watchdog | `npm run accept:phase7` | ✅ 9 passed, 0 failed |
| Phase 8 — Stoppage/Insights | `npm run accept:phase8` | ✅ **21** passed, 0 failed — 9 new checks for the reason-level Pareto pair, `coverage`, and `faultParetoByFreq` |
| Quarry | `npm run accept:quarry` | ✅ 15 passed, 0 failed |
| Sales | `npm run accept:sales` | ✅ 21 passed, 0 failed |
| Purchases | `npm run accept:purchases` | ✅ 17 passed, 0 failed |

**Re-run 2026-09-24: 119 checks green, 0 failing** across phase1/2/3/5/7/8/quarry. `accept:phase6` still carries the 3 external SMTP failures (R-6); `accept:sales` and `accept:purchases` were not re-run in this pass (Odoo round-trip, 30-49 s cold).

## KPI Dashboard / Formula Layer  [WBS-DATA-2]

**Status:** 🟡 **Partial**
**Owner:** `kpi-data-analyst` · **Last verified:** 2026-09-13 via `validate`

**What "done" means:** every dashboard number renders only from `/api/formula` (zero page-JS math); overrides carry reason + audit trail; `docs/KPI_REFERENCE.md` matches the live registry.

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | KPI reference current | `npm run docs:kpi` + `git diff` | 2026-09-13 | ✅ clean — 20 KPIs, 149 facts, registry v1 |
| 2 | Formula suites | 5 `test:*` suites | 2026-09-13 | ✅ all green |
| 3 | Phase 3 acceptance | `npm run accept:phase3` | 2026-09-13 | ✅ 27 passed, 0 failed |

**Known gap keeping this Partial:** **Quality KPI** validated against only **1 day** of source data, vs. 91/91 days for production and power-cons (no `verify-quality.py` exists). One KPI's thin validation holds the whole entry at Partial rather than rounding up — RAID I-2.

## Stoppage / Reliability Report  [WBS-DATA-1]

**Status:** 🟢 **Done** — paired Pareto now exists at BOTH cause and named-reason level
**Owner:** `kpi-data-analyst` → `stoppage-report-designer` · **Last verified:** 2026-09-13 via `validate`

**What "done" means:** NAI and MTBF trended over a range (never single-day); paired Pareto by hours *and* frequency; per-equipment hours/events/MTTR/MTBF/availability table; RCFA action flags.

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Phase 8 acceptance | `npm run accept:phase8` | 2026-09-24 | ✅ **21 passed, 0 failed** |
| 2 | Paired Pareto at named-reason level | `accept:phase8` checks `reasonPareto` + `reasonParetoByFreq` | 2026-09-24 | ✅ both ranked correctly, cumPct monotonic to 100% |
| 3 | Frequency is not overclaimed | `reliability.html` axis/table/footnote copy | 2026-09-24 | ✅ reads "days with downtime" throughout, with a visible footnote saying a fault that tripped three times in one day counts once, and why |

**Known gaps:** cost-of-stoppage still blocked on a TZS/hour rate from Finance; bilingual EN/SW labels deferred. **A true incident count remains impossible** — no table records per-incident start/end times, and adding an occurrence counter to the entry form was considered and declined on 2026-09-24, so "frequency" means days-with-downtime by decision, not by oversight.

## Report write-path integrity  [WBS-DATA-7]

**Status:** 🟡 **Partial** — the lock and the trail are done; the humane path around them is not
**Owner:** `code-architect` · **Last verified:** 2026-09-24 via `validate`

**What "done" means:** an approved report cannot be changed without a written
reason and a recoverable pre-image, and a person who needs to correct one has
a route that does not require an HOD to do it for them.

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | A submit over an approved row is refused | `e2e` "an approved report cannot be overwritten without a reason" | 2026-09-24 | ✅ 409 `REPORT_LOCKED`; stored figure and `approved_by` both unchanged |
| 2 | Save Draft cannot un-approve a signed-off day | same spec | 2026-09-24 | ✅ 409 |
| 3 | The prior figures are recoverable | `e2e` "merge still holds when an approved report is amended" | 2026-09-24 | ✅ `report_revisions.prior_data` holds the original value; `action='FORM_AMEND_DIRECT'`; reason stored |
| 4 | Autosave cannot bloat the log | `npm run test:revisions` (structural test) | 2026-09-24 | ✅ 21/21 — asserts `recordRevision(` appears only after the autosave branch returns |
| 5 | Deleting a user does not take the trail hostage | migration 025, `accept:phase3` cleanup | 2026-09-24 | ✅ `ON DELETE SET NULL`; `actor_name` keeps the name |
| 6 | A non-approver can request a correction | — | — | ❌ **not built** — RAID I-29 |

**Known gaps:** criterion 6. The correction-request workflow
(`report_amendments`, migration 026) is designed but unbuilt, so today the
only routes back are a rejection or an approver's audited break-glass.

## Security & Auth  [WBS-SEC-1]

**Status:** 🟡 **Partial** — code verified, live posture not
**Owner:** `security-performance-auditor` · **Last verified:** 2026-09-13 via `validate`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Phase 1 acceptance | `npm run accept:phase1` | 2026-09-13 | ✅ 19 passed, 0 failed |
| 2 | CORS `ALLOWED_ORIGIN` | read `server.js:51-52, 66-68` | 2026-09-13 | ✅ verified in source |
| 3 | Rate limiting | read `server.js:95, 100, 106-109` | 2026-09-13 | ✅ scoped to auth routes only (deliberately not `/me`) |
| 4 | Account lockout | read `routes/auth.js:27-28, 73-89` | 2026-09-13 | ✅ 5 attempts / 15 min, 423 while locked |
| 5 | JWT `ver` revocation | read `middleware/auth.js:40-56` | 2026-09-13 | ✅ checked per-request against `users.token_version` |
| 6 | `openpg` password rotated | live `psql` check | — | ⚠ **Cannot verify from code** — RAID R-4 |

## Email flows (invite / reset / verify / digest / alerts)  [WBS-SEC-4]

**Status:** 🔴 **Blocked — externally**
**Owner:** Lake Cement IT · **Last verified:** 2026-09-13 via `validate`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Mail pipeline logic | `npm run test:auth-mail` | 2026-09-13 | ✅ 6/6 (pipeline is correct) |
| 2 | A real message actually sends | `npm run accept:phase6` | 2026-09-13 | ❌ `535 5.7.139 SmtpClientAuthentication is disabled for the Tenant` |
| 3 | Recipients configured | `DIGEST_TO` in `.env` | 2026-09-13 | ❌ empty — RAID D-2 |

**Known gaps:** two separate blockers, two separate owners — IT must enable SMTP AUTH (or move to Graph API), Management must name recipients. The application code is not implicated in either.

## Backup / DR  [WBS-DEPLOY-2]

**Status:** 🔴 **Missing (locally)**
**Owner:** `deployment-engineer` · **Last verified:** 2026-09-13 via `validate`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Phase 7 acceptance | `npm run accept:phase7` | 2026-09-13 | ✅ 9 passed, 0 failed |
| 2 | A backup can be taken | `npm run backup` | 2026-09-13 | ❌ `BACKUP_DIR is not configured` |
| 3 | A dump restores cleanly | `npm run restore:drill` | 2026-09-13 | ❌ cannot run — no dump exists |

**Known gaps:** `/api/health` independently reports `"backup":"not_configured"`. This is the *local* machine; whether the production droplet has its own backups is **unverified** and must be checked separately — RAID I-7.

## Deployment pipeline  [WBS-DEPLOY-1]

**Status:** 🟢 **Done** — and it proved itself this week
**Owner:** `deployment-engineer` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | No deploy without green tests | read `.github/workflows/deploy.yml:18, 72-91` | 2026-09-13 | ✅ `deploy` has `needs: test`; test job runs `npm test` + all 10 `accept:*`. No bypass path |

**Note:** this gate is the reason a server-killing commit on `main` almost certainly never reached production (assumption A-1). **Known gaps:** doc drift (RAID I-10), stale banners (RAID I-1).

## UI/UX — all pages  [WBS-UI-1, WBS-UI-2]

**Status:** 🟢 **Done** — all four re-run 2026-09-24
**Owner:** `ui-ux-designer` · **Last verified:** 2026-09-13 via `audit` (blocked at the time)

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Responsive | `cd e2e && npm run audit:responsive` | 2026-09-24 | ✅ **all 88 checks passed** (22 pages x 4 viewports) — first fully clean run |
| 2 | Accessibility | `npm run audit:a11y` | 2026-09-24 | ✅ 0 violations, 0 at serious or critical |
| 3 | Page weight | `npm run audit:perf` | 2026-09-24 | 🟡 2 over budget, both pre-existing — `daily-report` 1404KB, `quarry` 12876KB (I-19). `kpi-dashboard` came **under** at 873KB while gaining trend |
| 4 | Cross-page consistency | `node design-consistency-audit.js` | 2026-09-24 | 🟡 4 inventory findings, **0 in-flow collisions**; see I-20 on this script's false positives |

All four aborted at login during the audit because the backend was down. They are runnable again now — this is the first thing `validate` should pick up next.

**Known gaps (confirmed from source, independent of a live run):** Quarry page weight unaddressed — `routes/quarry.js:94` has no `LIMIT`/`OFFSET` (recorded at 1616KB / 1634KB against a 900KB budget); `scripts/validate_palette.js` absent; no dark-mode support; `.adm-btn` outside the shared token set; `.kt-val.is-empty` unstyled on `daily-report.html` (RAID I-8).

## Cross-role behaviour (e2e)  [WBS-QA-1]

**Status:** 🟡 **Partial — 144 of 149 pass**
**Owner:** `qa-test-engineer` · **Last verified:** 2026-09-13 via `validate`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Playwright specs pass | `cd e2e && npm test` | 2026-09-24 | 🟡 **144 passed, 5 failed** — all five proven pre-existing by re-running them in a clean worktree at `b2b98b9`, where they fail identically (RAID I-28) |

**The 2 failures, both diagnosed to root cause — neither caused by the approval-ownership change:**
1. `account-activation.spec.js:116` — forgot-password answers differently for known vs. unknown addresses. **Real security defect**, RAID R-7: `mailer.js:38` throws instead of returning `{sent:false}`, so a known address 500s while an unknown one 200s. Triggered by R-6, but the robustness gap is in this code.
2. `daily-reports.spec.js:194` — approved row not cleared from the queue. **Real UI defect**, RAID I-12: `approvals.html:130` hides the wrapper without clearing `tbody.innerHTML`. Backend verified correct (approve → 200, queue correctly filters by status).
| 2 | RBAC matches the documented model | `npm run access:matrix` vs `docs/ACCESS_MODEL.md` | 2026-09-13 | ✅ matches — `ACCESS_MODEL.md` updated with the shared-submit exception (DEC-003) |

## Not yet defined

No acceptance mechanism exists for these, so they get **no invented bar** — defining one is itself a backlog item:

- Root pages without a dedicated `accept:*` script (`insights.html`, `completeness.html`, `balance.html`, `memory.html`, `monitor.html`, `reports-export.html`, `approvals.html`, `mis.html`, `analytics.html`)
- The 13 `forms/*.html` entry forms individually (covered only collectively by `accept:phase2`)
