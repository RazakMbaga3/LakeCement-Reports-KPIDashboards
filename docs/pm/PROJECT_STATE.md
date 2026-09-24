# Project State — Lake Cement Dashboard

**Single source of truth for where this project stands. Read this file first
in any session.** Maintained by the `project-manager` skill
(`.claude/skills/project-manager/SKILL.md`).

- **Last full audit:** 2026-09-13 (six specialist agents, every claim command-cited)
- **Last hardening run:** 2026-09-24 — thirteen commits, every one gated on a real command's real output before it was made
- **Last UI measurement:** 2026-09-24 — **responsive 88/88 checks pass** (22 pages x 4 viewports: 0 overflow, 0 text below the 12px floor of 5,649 nodes, 0 tap targets under 44px, 0 iOS-zoom triggers), **a11y 0 violations** across every page including all 5 correction-request UI states, perf 2 pages over budget (both pre-existing: `daily-report` 1404KB, `quarry` 12876KB / RAID I-19), design-consistency 4 inventory findings and 0 collisions
- **Last validation gate:** 2026-09-24 — backend 17 unit suites + smoke green; acceptance **phase1 19, phase2 18, phase3 27, phase5 10, phase7 9, phase8 21, quarry 15, amendments 92** = 211 checks, 0 failed; the five e2e failures logged earlier tonight as "pre-existing" (I-28) were re-diagnosed and fixed same-night — see below; a fresh full e2e run is in progress as the closing gate
- **Overall health:** 🟡 **Amber** — the write path is materially safer than it was yesterday and the correction-request workflow (I-29) is built and tested; remaining open items are the risks owned outside this repo (R-4, R-6, R-7) and I-19 (quarry payload)

---

## Current focus

**The 2026-09-24 hardening run closed the largest integrity hole in the app.**
Until this week, re-POSTing a report over an already-approved day merged
straight over it, reset the status and cleared `approved_by` — silently,
from any account with submit rights, leaving no record of the prior figures
anywhere in the database. `audit_log` said only "12 field(s), merged".

Three things changed. `report_revisions` (migration 024) is an append-only
pre-image log, so "what did this report say on Tuesday" now has an answer.
A submit — or a Save Draft — over a reported row returns **409
REPORT_LOCKED**, with a written-reason break-glass for admin/md and the
owning HOD. And the 1,374-line Excel import layer, which had no tests at
all, has 32 assertions against the real plant workbooks and no longer needs
the internet to open.

The Executive Summary was rebuilt on the same principle: **no invented
number survives on it.** 160 hardcoded Quarry Workshop actuals and 11
illustrative cards are gone; six of those cards graduated to live data
(three from `/api/insights/stoppages`, which had been computing them since
Phase 8, plus Burst Bag Rate, Clinker C₃S and CM-2 Output). Honesty cost
something visible: real April reliability is 93.6% availability and 58 h
MTBF against cards that used to read 99.5% and 180 h.

**WBS-A2 / RAID I-29 — the correction-request workflow — is now built and
closed**, same night as the lock that made it necessary. `report_amendments`
(migration 027), request/grant/decline/withdraw routes, a "Request a
correction" affordance + live poll + countdown window in
`forms/form-persist.js`, a second queue on `approvals.html`, and a 15-min
sweeper that restores the grant-time figures if a window closes unused. The
load-bearing invariant held under test: a grant never changes
`daily_reports.status`, so the day never leaves the KPIs/MIS pack/watchdog
while a correction is open. 92/92 acceptance checks, 22/22 unit invariants,
8/8 browser specs, 0 a11y/responsive violations across all five UI states.

**RAID I-28 — the five e2e failures — were also re-diagnosed and fixed
tonight**, not left as "pre-existing and therefore fine." None were app
defects: one stale test (stoppage ownership moved P&M→Production
2026-09-22), two tests asserting UI a deliberate commit had removed
(dispatch MTD moved off the entry form), and two date-fill helpers that
depended on live data state rather than the app's own logic. Root-caused and
fixed rather than skipped; see RAID_LOG.md for detail.

**Next up, in order:**
1. **A fresh full e2e run** to confirm the I-28 fixes hold together with
   everything else built tonight — in progress, not yet reported.
2. **R-7** (forgot-password address-enumeration — live, security) then
   **RAID I-19** (the 12.8 MB quarry payload, four times worse than when it
   was first logged).
3. **R-4/R-6** — both owned outside this repo (Lake Cement IT / whoever
   admins the Odoo Postgres).

---

## Workstream health

| Workstream | Owner agent | Health | Basis |
|---|---|---|---|
| Code/Architecture | `code-architect` | 🟢 Green | `npm test` green through smoke, now **17 suites**. The write path gained an append-only revision log, a real lock, AND a self-service correction workflow (024/025/027; `afed45e`, `81f349a`, `c495748`). Open: **I-19** — the quarry ticket endpoint now serves **12.8 MB** on every `mines-report.html` load, measured 2026-09-24, against the 1.6 MB recorded when it was logged |
| KPI/Data | `kpi-data-analyst` | 🟡 Amber | `accept:phase3` 27/27, `accept:phase8` **21/21** (was 12 — reason-level Pareto added), KPI reference byte-current at **32 KPIs / 170 facts**. The stoppage form's per-reason hours (`stopr_<id>`) are read by the server for the first time. Quality KPI still at 1-day validation (I-2) |
| UI/UX | `ui-ux-designer` | 🟢 Green | **Re-measured 2026-09-24: responsive 88/88 and a11y 0 violations** — the first fully clean responsive run, now including all 5 correction-request UI states. The Executive Summary carries trend for the first time, as inline SVG rather than a 205KB chart bundle, and came in **under** its transfer budget (873KB, FCP 2524ms) |
| QA/Testing | `qa-test-engineer` | 🟢 Green | **211 acceptance checks green across 8 suites** (phase1/2/3/5/7/8/quarry/amendments); 17 unit suites green. RAID I-28's five e2e failures were root-caused and fixed, not left red — a fresh full run is confirming the fix set now. The Excel import layer went from 0 tests to 32; the correction-request workflow got 8 new browser specs plus 92 acceptance checks |
| Security/Performance | `security-performance-auditor` | 🟡 Amber | Auth internals verified in source; `accept:phase1` 19/19. `openpg` unverifiable from code (R-4); email blocked at the tenant (R-6); perf not re-measured |
| Deployment | `deployment-engineer` | 🟡 Amber | CI gate verified sound and demonstrably effective. No local backups at all (I-7); stale runbook banners (I-1) |

Legend: 🟢 on track, evidence current · 🟡 partial/at risk · 🔴 blocked/failing

---

## What this audit actually proved

1. **All nine unit suites passed green — 54 assertions — while the
   application was completely unbootable.** (Ten suites and 59 assertions
   now, with the guard this audit showed was missing.) The strongest possible argument
   for the rule this system enforces: a DoD entry needs a boot-dependent
   gate, never unit-test green alone. That specific gap is now closed by
   `backend/test/approval-owner.test.js`.
2. **The CI gate you built worked.** `deploy` sits behind `needs: test`,
   which is why a server-killing commit on `main` almost certainly never
   reached production (assumption A-1 — worth confirming in the Actions run
   history).
3. **Evidence beat recall three times on one risk.** "SMTP not configured"
   → disproved by a key check (everything *is* set) → re-scoped to an empty
   `DIGEST_TO` → then disproved *again* by an actual send attempt, which
   returned `535 5.7.139 SmtpClientAuthentication is disabled for the
   Tenant`. Final state: two blockers, two different owners (R-6 IT, D-2
   Management). None of this was visible from reading code.
4. **Specialists disagreed once** (SMTP state) and it was settled by direct
   check rather than by trusting the more confident agent.

## Top open risks

| ID | Severity | Item | Owner |
|---|---|---|---|
| **R-7** | **High — security, live** | forgot-password leaks which emails have accounts (known → 500, unknown → 200) because a send failure throws instead of returning `{sent:false}` | `security-performance-auditor` |
| R-6 | High | No email can send — tenant blocks SMTP AUTH | Lake Cement IT |
| R-4 | High | `openpg` may still hold its default password | `security-performance-auditor` / You |
| R-1 | Medium | Odoo dispatch and mining moved to production 2026-09-23, same host/key as production/sales/purchases; app-side done, droplet `.env` + its own backfill still pending (re-scoped 2026-09-23) | You → whoever holds droplet SSH access |
| I-7 | Medium | No backups configured locally; droplet state unverified | `deployment-engineer` |
| I-2 | Medium | Quality KPI validated on 1 day of data vs. 91 for others | `kpi-data-analyst` |

Full log: [`RAID_LOG.md`](RAID_LOG.md) — 14 open, 2 assumptions, 4 closed/corrected.

## Go-live blockers owned outside this repo

- **Lake Cement IT:** enable SMTP AUTH for `digital@lakecement.co.tz`, or move the sender to Graph API (R-6)
- **Odoo Team:** approval status, run hours and a crusher group on `production_report`; a Dispatch-report field for the "CEMENT B-M 42.5 N" (Duramax 42) grade; Purchases field names; network path droplet↔Odoo (D-1). (`dispatch_report`/`mining_report` on production — done 2026-09-23, see R-1.)
- **Management / Plant Head:** who receives the daily digest and alerts (D-2); confirm the E&I approval decision (DEC-003)
- **Whoever admins the Odoo-bundled Postgres:** `openpg` rotation (R-4)

## Links

[`WBS.md`](WBS.md) · [`GANTT.md`](GANTT.md) ·
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) ·
[`RAID_LOG.md`](RAID_LOG.md) · [`RACI.md`](RACI.md) ·
[`KANBAN.md`](KANBAN.md) · [`DECISIONS.md`](DECISIONS.md)

Superseded (kept as evidence): [`../PROGRESS.md`](../PROGRESS.md),
[`../RUNBOOK.md`](../RUNBOOK.md), [`../GO_LIVE_CHECKLIST.md`](../GO_LIVE_CHECKLIST.md)

## Kanban snapshot

Done 3 · In Progress 1 · To Do 3 · Blocked 6 · Backlog 6 — see
[`KANBAN.md`](KANBAN.md).
