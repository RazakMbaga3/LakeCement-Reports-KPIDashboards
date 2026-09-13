# Definition of Done — Lake Cement Dashboard

Evidence-only. Status is set **only** by the `project-manager` skill's
`audit` or `validate` mode, and only from a real command's real output —
never from a code read, a subagent's unverified claim, or visual inspection.
See `.claude/skills/project-manager/SKILL.md`.

**Audited 2026-09-13.** Nearly every entry below reads **Blocked** for the
same reason: the backend does not boot on current `main` (RAID I-3), so 9 of
10 acceptance suites, `access:matrix`, and the entire e2e suite abort before
running a single check. Historical pass counts from `docs/PROGRESS.md` are
recorded here as *prior claims*, **not** as current evidence — under this
system a stale green does not count.

> **Rule this audit proved necessary:** all 10 unit suites (45 assertions)
> passed green while the application was completely unbootable. Unit-test
> green is not proof of a working system — that's why every DoD entry
> requires a boot-dependent gate, not just unit tests.

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

**Status:** 🔴 **Missing — the server does not start**
**Owner:** `code-architect` · **Last verified:** 2026-09-13 via `audit`

**What "done" means:** `node server.js` opens its listener; `npm run smoke` passes.

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Server boots | `cd backend && npm run smoke` | 2026-09-13 | ❌ `SMOKE FAIL — server exited early (code 1)` |
| 2 | No module-load throw | `node server.js` | 2026-09-13 | ❌ throws at `middleware/approval.js:19` — `power-cons` claimed by both `pm` and `ei` |

**Known gaps:** Root cause is commit `fa3d5ae`. Needs an approval-ownership decision (see RAID I-3) before it can be fixed correctly.

## Unit / formula test layer  [WBS-DATA-2, WBS-CODE-1]

**Status:** 🟢 **Done** (the one area genuinely verified this audit)
**Owner:** `qa-test-engineer` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Lint | `cd backend && npm run lint` | 2026-09-13 | ⚠ 0 errors, 2 warnings (RAID R-5) |
| 2 | Formulas | `npm run test:formulas` | 2026-09-13 | ✅ 4/4 |
| 3 | Facts | `npm run test:facts` | 2026-09-13 | ✅ 2/2 |
| 4 | Access consistency | `npm run test:access` | 2026-09-13 | ✅ 8/8 |
| 5 | Stores | `npm run test:stores` | 2026-09-13 | ✅ 5/5 |
| 6 | KPI keys | `npm run test:kpi-keys` | 2026-09-13 | ✅ 5/5 |
| 7 | Form↔fact coverage | `npm run test:form-facts` | 2026-09-13 | ✅ 4/4 |
| 8 | KPI edit level | `npm run test:kpi-level` | 2026-09-13 | ✅ 8/8 |
| 9 | Auth tokens | `npm run test:auth-tokens` | 2026-09-13 | ✅ 12/12 |
| 10 | Auth mail | `npm run test:auth-mail` | 2026-09-13 | ✅ 6/6 |

**Known gaps:** No test covers the single-owner invariant `approval.js` enforces — which is exactly how the outage passed all 10 suites (RAID I-5, WBS-QA-2).

## KPI Dashboard / Formula Layer  [WBS-DATA-2]

**Status:** 🟡 **Partial**
**Owner:** `kpi-data-analyst` · **Last verified:** 2026-09-13 via `audit`

**What "done" means:** every dashboard number renders only from `/api/formula` (zero page-JS math); overrides carry reason + audit trail; `docs/KPI_REFERENCE.md` matches the live registry.

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | KPI reference current | `npm run docs:kpi` + `git diff docs/KPI_REFERENCE.md` | 2026-09-13 | ✅ clean diff — 20 KPIs, 149 facts, registry v1 |
| 2 | Formula suites | the 5 `test:*` suites above | 2026-09-13 | ✅ all green |
| 3 | Phase 3 acceptance | `npm run accept:phase3` | 2026-09-13 | 🔴 **Blocked** — server won't boot (prior claim: 25/25 green, 2026-07-06 — not current evidence) |

**Known gaps:** **Quality KPI** validated against only **1 day** of source data, vs. 91/91 days for production and power-cons (no `verify-quality.py` exists). The dashboard as a whole cannot read Done while one of its KPIs sits at that validation depth — RAID I-2.

## Stoppage / Reliability Report  [WBS-DATA-1]

**Status:** 🟡 **Partial** (bar unchanged; evidence not currently obtainable)
**Owner:** `kpi-data-analyst` → `stoppage-report-designer` · **Last verified:** 2026-09-13 via `audit`

**What "done" means:** NAI and MTBF trended over a range (never single-day); paired Pareto by hours *and* frequency; per-equipment hours/events/MTTR/MTBF/availability table; RCFA action flags.

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Phase 8 acceptance | `npm run accept:phase8` | 2026-09-13 | 🔴 **Blocked** — server won't boot (prior claim: 12/12 green) |

**Known gaps:** stoppage-insights UI page deferred; cost-of-stoppage blocked on a TZS/hour rate from Finance; bilingual EN/SW labels deferred.

## Security & Auth  [WBS-SEC-1]

**Status:** 🟡 **Partial** — code verified, live posture not
**Owner:** `security-performance-auditor` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | CORS `ALLOWED_ORIGIN` wired | read `server.js:51-52, 66-68` | 2026-09-13 | ✅ verified in source |
| 2 | Rate limiting | read `server.js:95, 100, 106-109` | 2026-09-13 | ✅ scoped to auth routes only (deliberately not `/me`) |
| 3 | Account lockout | read `routes/auth.js:27-28, 73-89` | 2026-09-13 | ✅ 5 attempts / 15 min, 423 while locked |
| 4 | JWT `ver` revocation | read `routes/auth.js:40`, `middleware/auth.js:40-56` | 2026-09-13 | ✅ checked per-request against `users.token_version` |
| 5 | Phase 1 acceptance | `npm run accept:phase1` | 2026-09-13 | 🔴 **Blocked** (prior claim: 19/19 green) |
| 6 | `openpg` password rotated | live `psql` check | — | ⚠ **Cannot verify from code** — RAID R-4 |

## Backup / DR  [WBS-DEPLOY-2]

**Status:** 🔴 **Missing**
**Owner:** `deployment-engineer` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | A backup can be taken | `npm run backup` | 2026-09-13 | ❌ `BACKUP_DIR is not configured` — no backups run here |
| 2 | A dump restores cleanly | `npm run restore:drill` | 2026-09-13 | ❌ cannot run — no dump exists |
| 3 | Phase 7 acceptance | `npm run accept:phase7` | 2026-09-13 | ❌ **6 passed, 3 failed** — all 3 backup-health checks fail because `/api/health` never came up |

**Known gaps:** This is the *local* machine's state. Whether the production droplet has its own backups configured is **unverified** and must be checked separately.

## Deployment pipeline  [WBS-DEPLOY-1]

**Status:** 🟢 **Done** — the CI gate itself is sound
**Owner:** `deployment-engineer` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | No deploy without green tests | read `.github/workflows/deploy.yml:18, 72-91` | 2026-09-13 | ✅ `deploy` has `needs: test`; test job runs `npm test` + all 10 `accept:*`. No bypass path exists |

**Known gaps:** doc drift — `DEPLOYMENT_DIGITALOCEAN.md:267` misdescribes `deploy.sh:14` (RAID I-10); RUNBOOK/GO_LIVE banners stale (RAID I-1). Neither affects the gate's correctness.

## UI/UX — all pages  [WBS-UI-1, WBS-UI-2]

**Status:** 🔴 **Blocked — not measurable during the outage**
**Owner:** `ui-ux-designer` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | Responsive | `cd e2e && npm run audit:responsive` | 2026-09-13 | 🔴 aborted at login (backend down) |
| 2 | Accessibility | `npm run audit:a11y` | 2026-09-13 | 🔴 aborted at login |
| 3 | Page weight | `npm run audit:perf` | 2026-09-13 | 🔴 aborted at login |
| 4 | Cross-page consistency | `node design-consistency-audit.js` | 2026-09-13 | 🔴 aborted at login |

**Known gaps (confirmed from source, not from a live run):** Quarry page weight still unaddressed — `routes/quarry.js:94` has no `LIMIT`/`OFFSET` (doc records 1616KB and 1634KB against a 900KB budget); `scripts/validate_palette.js` still absent; no dark-mode support anywhere; `.adm-btn` still a page-local class outside the shared token set; `.kt-val.is-empty` unstyled on `daily-report.html` (RAID I-8).

## Cross-role behaviour (e2e)  [WBS-QA-1, WBS-QA-3]

**Status:** 🔴 **Blocked**
**Owner:** `qa-test-engineer` · **Last verified:** 2026-09-13 via `audit`

| # | Criterion | Evidence source | Last verified | Result |
|---|---|---|---|---|
| 1 | 15 Playwright specs pass | `cd e2e && npm test` | 2026-09-13 | 🔴 **zero tests executed** — Playwright's `webServer` couldn't start the backend |
| 2 | RBAC matches the documented model | `npm run access:matrix` vs `docs/ACCESS_MODEL.md` | 2026-09-13 | 🔴 crashed before printing anything |

**Known gaps:** `docs/ACCESS_MODEL.md` documents approval as "own department's form types only" — a single-owner model. Code now lets two departments submit `power-cons` with no corresponding approval rule, and the doc never records the exception. Documentation and code must be reconciled as part of WBS-CODE-2, not after it.

## Not yet defined

These have no acceptance mechanism, so they get **no invented bar** — defining one is itself a backlog item:

- Individual root pages without a dedicated `accept:*` script (`insights.html`, `completeness.html`, `balance.html`, `memory.html`, `monitor.html`, `reports-export.html`, `approvals.html`, `mis.html`, `analytics.html`)
- The 13 `forms/*.html` entry forms individually (covered only collectively by `accept:phase2`)

---

**Nothing in this file may move to Done until the backend boots and the
gate table is re-run (WBS-QA-3).** Every 🔴 above is one command away from a
real answer once that happens.
