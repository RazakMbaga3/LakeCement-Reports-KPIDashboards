# Project State — Lake Cement Dashboard

**Single source of truth for where this project stands. Read this file first
in any session.** Maintained by the `project-manager` skill
(`.claude/skills/project-manager/SKILL.md`).

- **Last full audit:** 2026-09-13 (six specialist agents, every claim command-cited)
- **Last validation gate:** 2026-09-13 — 147 acceptance checks green + e2e 117/119; 5 failures, all root-caused
- **Overall health:** 🟡 **Amber** — backend restored and verified; one live security defect found (R-7), rest owned outside this repo

---

## Current focus

The P0 that opened this audit is **closed**. Commit `fa3d5ae` had left the
backend unbootable (`power-cons` claimed by both `pm` and `ei`, with
`approval.js` refusing to guess an approver). Per **DEC-003**, E&I's HOD now
approves Power Consumption, P&M keeps submit rights, and approval ownership
is declared explicitly rather than inferred. The guard that caught it is
still armed — and now has a test proving it still fires.

**Two defects the re-verification then found, both logged and neither fixed
(they are outside the approved scope — see R-3 on scope creep):**
**R-7 / WBS-SEC-5** is a live address-enumeration oracle on forgot-password
— recommend fixing next, it is small and currently exploitable.
**I-12 / WBS-UI-3** leaves a stale row in the approvals table DOM.

**Next up:** fix R-7, then re-run the four UI audit scripts (`audit:responsive`,
`audit:a11y`, `audit:perf`, `design-consistency-audit.js`). They aborted at
login during the outage and have not been measured since; they are runnable
again now. After that, `WBS-DATA-2` (Quality KPI validation) is the largest
piece of genuine engineering left that isn't waiting on someone else.

---

## Workstream health

| Workstream | Owner agent | Health | Basis |
|---|---|---|---|
| Code/Architecture | `code-architect` | 🟢 Green | Boots and verified; `npm test` green through smoke. Open: 2 audit_log gaps (I-9), 2 lint warnings (R-5) |
| KPI/Data | `kpi-data-analyst` | 🟡 Amber | `accept:phase3` 27/27, KPI reference byte-current, all formula suites green. Quality KPI still at 1-day validation (I-2); Odoo on a TEST instance (R-1) |
| UI/UX | `ui-ux-designer` | 🟡 Amber | Unblocked but **not re-measured** since the outage. 5 of 6 prior "still open" design-audit items confirmed still open from source |
| QA/Testing | `qa-test-engineer` | 🟢 Green | 147 acceptance checks green across 9 suites; 11 unit suites green; the invariant gap that caused the outage is now covered by `test:approval` |
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
| R-1 | High | Odoo wired to a TEST instance, not production | You → Odoo Team |
| I-7 | Medium | No backups configured locally; droplet state unverified | `deployment-engineer` |
| I-2 | Medium | Quality KPI validated on 1 day of data vs. 91 for others | `kpi-data-analyst` |

Full log: [`RAID_LOG.md`](RAID_LOG.md) — 14 open, 2 assumptions, 4 closed/corrected.

## Go-live blockers owned outside this repo

- **Lake Cement IT:** enable SMTP AUTH for `digital@lakecement.co.tz`, or move the sender to Graph API (R-6)
- **Odoo Team:** production Odoo endpoint + key, Purchases field names, network path droplet↔Odoo (R-1, D-1)
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
