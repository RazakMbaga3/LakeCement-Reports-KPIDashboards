# Project State — Lake Cement Dashboard

**Single source of truth for where this project stands. Read this file first
in any session.** Maintained by the `project-manager` skill
(`.claude/skills/project-manager/SKILL.md`).

- **Last full audit:** 2026-09-13 (six specialist agents, every claim command-cited)
- **Last validation gate:** 2026-09-13 — *failed at the first gate; see below*
- **Overall health:** 🔴 **Red** — the backend does not boot on current `main`

---

## ⚠ Current focus — one decision unblocks almost everything

`WBS-CODE-2` / RAID `I-3`: commit `fa3d5ae` ("Give E&I access to the Power
Consumption Report") gave `ei` submit rights on `power-cons` while `pm` still
owned it. [`middleware/approval.js:15-23`](../../backend/middleware/approval.js#L15-L23)
deliberately throws at module load when two roles claim one form type, so
`require('./server.js')` dies before the listener opens.

**What that one line currently takes down:** `npm run smoke`, 9 of 10
`accept:*` suites, `access:matrix`, and all 15 e2e specs (Playwright's
`webServer` can't start). Confirmed independently by four of the six
specialist agents.

**Production is very likely unaffected** —
[`deploy.yml:90-91`](../../.github/workflows/deploy.yml#L90-L91) gates
`deploy` behind `needs: test`, and the test job runs `npm test` plus all ten
acceptance suites, so the broken commit could not have reached the droplet.
Tracked as assumption **A-1** (unverified — no `gh` CLI here; confirm via the
Actions run history for `fa3d5ae`).

**The decision needed from you:** both P&M and E&I can *submit* power-cons,
but `requireApprover` needs exactly one *approving* role. Who approves Power
Consumption submissions — P&M HOD or E&I HOD? Code cannot answer this; it's
an org question, and per [`RACI.md`](RACI.md) access/RBAC policy is
Accountable to the Plant Head.

---

## Workstream health

| Workstream | Owner agent | Health | Basis |
|---|---|---|---|
| Code/Architecture | `code-architect` | 🔴 Red | Server unbootable (I-3); 2 audit_log gaps (I-9); 2 lint warnings (R-5) |
| KPI/Data | `kpi-data-analyst` | 🟡 Amber | `KPI_REFERENCE.md` byte-current, all 5 formula suites green; Quality KPI still at 1-day validation (I-2); Odoo on a TEST instance (R-1) |
| UI/UX | `ui-ux-designer` | ⬜ Unmeasurable | All 4 audit scripts aborted at login (I-4). Source-level: 5 of 6 prior "still open" items confirmed still open |
| QA/Testing | `qa-test-engineer` | 🔴 Red | 10/10 unit suites green (45 assertions) but every boot-dependent gate blocked; no test guards the invariant that broke (I-5) |
| Security/Performance | `security-performance-auditor` | 🟡 Amber | CORS/rate-limit/lockout/JWT-revocation all verified in source; `openpg` password unverifiable from code (R-4); perf unmeasurable |
| Deployment | `deployment-engineer` | 🟡 Amber | CI gate verified sound; no local backups at all (I-7); RUNBOOK banners stale (I-1) |

Legend: 🟢 on track, evidence current · 🟡 partial/at risk · 🔴 blocked/failing · ⬜ not measurable right now

---

## What this audit actually proved

1. **All 10 unit suites passed green (45 assertions) while the application
   was completely unbootable.** This is the strongest possible argument for
   the rule this system now enforces: a DoD entry needs a boot-dependent
   gate, never unit-test green alone.
2. **The CI gate you built worked.** It is the reason a server-killing
   commit on `main` most likely never reached production.
3. **Two seeded assumptions were wrong and got corrected by evidence** —
   SMTP is fully configured (the real gap is an empty `DIGEST_TO`, a
   *business* decision), and the RUNBOOK banners are stale in a different way
   than assumed. Both were carried in from prior context; both are now fixed
   in [`RAID_LOG.md`](RAID_LOG.md).
4. **Specialists disagreed once** (SMTP config state) and it was settled by
   direct check rather than by picking the more confident agent.

## Top open risks

| ID | Severity | Item | Owner |
|---|---|---|---|
| I-3 | **P0** | Backend does not boot — blocks all verification | You (decision) + `code-architect` |
| I-4 | High | Every gate blocked by I-3 | `qa-test-engineer` |
| I-5 | High | No test guards the invariant that caused I-3 | `code-architect` |
| R-4 | High | `openpg` may still hold its default password | `security-performance-auditor` / You |
| R-1 | High | Odoo wired to a TEST instance, not production | You → Odoo Team |

Full log with owners and mitigations: [`RAID_LOG.md`](RAID_LOG.md) — 16 open
items, 2 assumptions, 1 corrected.

## Go-live blockers owned outside this repo

- **Odoo Team:** production Odoo endpoint + key, Purchases field names, network path droplet↔Odoo
- **Management/Plant Head:** who receives the daily digest (`DIGEST_TO` is empty)
- **Whoever admins the Odoo-bundled Postgres:** `openpg` password rotation

## Links

[`WBS.md`](WBS.md) · [`GANTT.md`](GANTT.md) ·
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) ·
[`RAID_LOG.md`](RAID_LOG.md) · [`RACI.md`](RACI.md) ·
[`KANBAN.md`](KANBAN.md) · [`DECISIONS.md`](DECISIONS.md)

Superseded (kept as evidence): [`../PROGRESS.md`](../PROGRESS.md),
[`../RUNBOOK.md`](../RUNBOOK.md), [`../GO_LIVE_CHECKLIST.md`](../GO_LIVE_CHECKLIST.md)

## Kanban snapshot

Blocked 6 · To Do 4 · In Progress 1 (WBS-CODE-2, awaiting your decision) ·
Backlog 5 · Done 0 — see [`KANBAN.md`](KANBAN.md). Nothing has passed a
`validate` gate yet, by design: the gates can't run.
