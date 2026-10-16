# Project State — Lake Cement Dashboard

**Single source of truth for where this project stands. Read this file first
in any session.** Maintained by the `project-manager` skill
(`.claude/skills/project-manager/SKILL.md`).

- **Last full audit:** 2026-09-13 (six specialist agents, every claim command-cited)
- **Last hardening run:** 2026-09-24 — thirteen commits, every one gated on a real command's real output before it was made
- **Last UI measurement:** 2026-09-24 — **responsive 88/88 checks pass** (22 pages x 4 viewports: 0 overflow, 0 text below the 12px floor of 5,649 nodes, 0 tap targets under 44px, 0 iOS-zoom triggers), **a11y 0 violations** across every page including all 5 correction-request UI states, perf 2 pages over budget (both pre-existing: `daily-report` 1404KB, `quarry` 12876KB / RAID I-19), design-consistency 4 inventory findings and 0 collisions
- **Last feature gate:** 2026-10-12 — Compliance Master (see Current focus)
- **Last validation gate:** **2026-10-13** — backend **327 assertions across 29 suites, 0 failed**, `eslint` clean, `smoke` OK (`npm test`, run twice). This supersedes the 2026-09-24 figure of "17 suites / 211 acceptance checks": ~25 commits landed between those dates (Compliance Master, the Sale Register re-source, the new Odoo production payload, two-level sign-off, corrections/reopen) and the test base grew with them. Acceptance + e2e re-measurement was dispatched the same day — see **Inspection 2026-10-13** below
- **Overall health:** 🟡 **Amber** — unchanged verdict, materially changed reasons. Code and integration are in good shape (production stable, all five Odoo pulls `ok`); the open items are **(a) secrets leaked by I-42 that are still valid and unrotated**, **(b) I-38 security headers never actually deployed**, and **(c) human report filing has stopped almost entirely** (see below). R-7 and R-6 are closed; I-19 and I-35 are closed

### Inspection 2026-10-13 (`project-manager status`, every claim command-verified)

Run because this file had gone 13 days and ~25 commits stale. Three findings
change the plan; two correct this file in the project's favour.

**🔴 I-38 is NOT deployed, 13 days after being recorded as fixed in tree.**
`curl -sS -D - https://smr.lakecement.co.tz/login.html` returns
`X-Content-Type-Options` and *nothing else* — no HSTS, CSP, X-Frame-Options or
Referrer-Policy — while `/api/health` carries the full helmet set. The page
where credentials are typed is the least protected page on the site. Root
cause is deeper than a missed reload: login.html returns **no `Cache-Control`
at all**, so the running config predates even the `.html` caching block —
`/etc/nginx/` has drifted from the repo, and `deploy.sh` does not copy nginx
configs, so **deploying can never apply this fix**. Sudo-gated. See I-38.

**🔴 I-42's access is closed but its leaked secrets are still live.**
`/backend/.env`, `/.git/config` and `/backend/db/seed.js` all now return 404
(verified). But tokens are symmetric HMAC on `JWT_SECRET`
(`routes/auth.js:42`), so anyone who downloaded `.env` during the window can
still **forge an admin/MD session with no password**, and a password reset
does not revoke it — only rotating the secret does. `db/seed.js:24-47`
published every account's plaintext password on a guessable `Role@LCL2026`
pattern (partially mitigated: `seed.js:135` sets `must_change_password=true`,
so never-used accounts are gated). The Graph client secret posts to
`/users/{from}/sendMail` (`services/mailer.js:68`) — with application
`Mail.Send` that is **send-as-any-mailbox**, MD included. **Perishable
action: grep the nginx access logs for `.env`/`.git` hits** — that single
answer decides breach vs near-miss, and logs rotate.

**🔴 Human data entry has stopped almost completely — this is now the
launch-gating fact.** Rows filed since 2026-08-01, by author:
production 67 / dispatch 67 / materials 41 are **100% Odoo-filled
(`submitted_by IS NULL`)**; the only human-typed stream, **cpp, stopped
2026-09-20 (23 days)**. Staleness: materials/production/dispatch 3 days;
cpp 23; stoppage/power-cons/limestone **105**; quality **175** (one row ever).
KPI nulls therefore improved only 21/32 → **18/32** for Aug and Sep, and
October is **worse at 24/32** because CPP's silence alone cost 7 KPIs.
**Odoo automation cannot close this** — it feeds none of the silent streams;
15 of the 18 nulls sit behind power-cons, stoppage, limestone and quality.
Already distorting the system: `despatch-day` was re-sourced to v5 precisely
because the CM-1 ledger stopped being recorded on 2026-07-01. See I-37.

**🔴 And the reason why, found by following that thread — I-45, the root
cause: 27 of the 50 real accounts have never logged in.** The named-user
migration (43 shared dept logins → named users, L1 approves / L2–L3 enter)
was built and deployed, but **nobody was onboarded onto it.** Entire
departments are at zero — HR & ADMIN 3/3 never, FINANCE 3/3 never — and in
*every* operational department only the shared HOD login has ever been
active, with `*_officer` and `*_senior` unused. CPP proves the pattern: all
77 of its filed days came from the shared `cpp` login (whose own
`last_login` is 2026-07-28, last submit 2026-09-23), while `cpp_officer` and
`cpp_senior` read `NEVER`. **So the access model is not in force anywhere in
practice** — separation of duties, per-person attribution and the approval
chain all currently rest on shared logins. This reframes the data gap from a
discipline problem into an **onboarding** problem, which is tractable: the
fix is handing out accounts, not asking people to try harder. Sequence it
**after** the I-42 `JWT_SECRET` rotation, which signs everyone out and
forces a fresh login anyway — the two combine into one clean cutover.

**✅ Two corrections in this project's favour, previously unrecorded:**
- **I-35 / launch blocker B-2 is CLOSED.** `daily_reports` holds
  `approved 844, pending_approval 137` and **zero drafts table-wide**. The
  ~210 invisible dispatch days now reach every KPI.
- **Production is healthy.** Uptime 6.3 h and climbing monotonically (no I-32
  crash-loop signature); **all five Odoo pulls `ok`**, last success 6–7 min
  ago. Health reads `degraded` for exactly one reason: `same_disk_as_app:
  true`, backups 10.2 h old (I-39 confirmed open).

**Acceptance + e2e, re-measured in full 2026-10-13 — 14 of 16 gates green:**
**512 acceptance checks, 507 pass, 5 fail across 16 suites** (supersedes "211
checks"). Green: phase1 19, phase2 18, phase3 27, phase5 10, phase6 16,
phase7 9, phase8 21, quarry 22, sales 24, purchases 22, corrections 67,
compliance 65, it-assets 53, odoo-production-autofill 24. **RED:**
`accept:odoo-production` 31/32 (**I-46 — a real defect**) and
`accept:amendments` 88/92 (**I-48 — a stale test, lock is correct**).
e2e **185 pass / 2 fail / 1 skipped** — both failures are
`stores-odoo-feed.spec.js` breaking the harness's own date isolation
(**I-49**), flake ruled out by re-running alone. a11y **0 violations** across
25 pages × 4 viewports. responsive **96/100**, a one-line 11px regression at
`purchases.html:85` — **fixed in this pass**. perf (informational):
**I-19 CLOSED — `quarry` is 834 KB and in budget, from 12,876 KB**, confirmed
in a real throttled browser; `daily-report` still over at 1497 KB; `mis` and
`compliance` marginally over on FCP only (~0.6%).

Also verified: CI gate intact — `deploy: needs: test`
(`.github/workflows/deploy.yml:93`), running 12 acceptance suites. **But four
suites run outside it — and they are exactly the two that are RED, which is
why nobody noticed (I-47):** `accept:amendments`, `accept:it-assets`,
`accept:odoo-production`, `accept:odoo-production-autofill`.
`docs/KPI_REFERENCE.md` was **drifted** (documented despatch-day v4 vs actual
v5, cement-produced v1 vs v2, SPC-total v4 vs v5; said 170 facts vs 171) and
has been regenerated. Caveat: all data figures are the **dev DB, not the
droplet** — droplet KPI coverage is unverified.

---

## Current focus

**2026-10-12 — Compliance Master built and verified** (branch `feature/compliance-master`).
It replaces `1. Compliance Master.xlsx` with `compliance.html` + `/api/compliance`:
- three kinds of obligation, with status computed from the dates;
- documents and versions stored in Postgres;
- tiered reminders sent through the Graph mailer, exactly once, held until each record is verified.

Decisions are DEC-009–014. The guide and the go-live steps are in `docs/COMPLIANCE_MASTER.md`.

Evidence (commands run 2026-10-12):
- `npm test` green, with 4 new compliance suites.
- `accept:compliance` **65/65** on the real workbook (203 records, every row reconciled) and **64/64** on the synthetic CI workbook, including a database built fresh from `schema.sql`.
- `accept:phase6` 16/16, `accept:phase7` 9/9, `accept:corrections` 67/67 unchanged.
- e2e `compliance.spec.js` **7/7**.
- `audit:a11y` 0 violations; `audit:responsive` **100/100**.
- `audit:perf`: compliance 742 KB / 24 requests, within budget (the two over-budget pages are pre-existing).

**Go-live steps** (owners outside the code):
1. Import the workbook in production (admin).
2. Fill the 19 missing email addresses (D-3).
3. The MD sets the Head list.
4. Each department verifies its records (R-8).
5. The MD switches reminders on.

Open: I-43 (who owns the PRODUCTION calibrations).

### Previous focus (2026-09-24)

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
2. ~~**R-7**~~ closed (verified live 2026-09-30). **RAID I-19** remains —
   the quarry payload re-measured **12.67 MB / 49,559 rows** on 2026-09-30,
   still unbounded with no `LIMIT` and no pagination.
3. **R-4/R-6** — both owned outside this repo (Lake Cement IT / whoever
   admins the Odoo Postgres).

---

## Launch readiness (2026-09-30)

A full launch-readiness assessment was run on 2026-09-30 and its package
lives in [`../launch/`](../launch/) — start at
[`LAUNCH_READINESS_REPORT.md`](../launch/LAUNCH_READINESS_REPORT.md).

**Verdict: GO WITH CONDITIONS.** The finding that matters most inverts the
usual launch problem: **the software is in better shape than the
organisation's readiness to use it.**

What the audit re-verified by direct command, not by reading docs: `npm test`
17 suites + smoke green; **76 of 81 API endpoints authorization-guarded**, the
5 open ones being exactly the pre-login endpoints; HTTPS **live** (301→200);
CI gate effective; and **all 12 ratio KPIs production-weighted, not
averaged** — the defect this class of system most often has, and this one
does not. Two entries in this very file were disproved by live testing and
corrected: HTTPS and R-7 were both recorded as outstanding and are in fact
done.

Five launch blockers, only one of which is a coding problem:

| # | Blocker | RAID | Owner |
|---|---|---|---|
| B-1 | **21 of 32 KPIs read "no data"** for 2026-08/09 — 5 streams silent since 2026-06-30 | **I-37** | Plant Head + HODs |
| B-2 | 210 days of dispatch tonnage held as `draft`, invisible to every KPI | I-35 | Plant Head + Logistics/Packing |
| B-3 | No user documentation existed | **I-40** | User (drafted) + HODs to review |
| B-4 | Static pages carried **no** security headers — including `login.html` | **I-38** | Fixed in tree; needs droplet reload + live verify |
| B-5 | Backups on the app's own disk; no restore ever demonstrated | **I-39** | deployment-engineer |

B-1 and B-2 are business decisions and they set the launch date. Neither is
the developer's to make.

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
| ~~R-7~~ | **CLOSED 2026-09-30** | forgot-password enumeration is fixed, and fixed more thoroughly than logged: both branches now reply `SAME_ANSWER` after a single lookup, *before* any token issue or SMTP round trip — which closes the timing oracle (~1.9s vs ~20ms) as well as the status-code one. ✅ verified **live**: unknown address → 200, malformed → 400 | `security-performance-auditor` |
| ~~R-6~~ | **CLOSED 2026-10-12** | Mail now goes through Microsoft Graph, not SMTP; real send verified, `accept:phase6` 16/16. Droplet `.env` still needs the three `GRAPH_*` keys | You → droplet |
| R-4 | High | `openpg` may still hold its default password | `security-performance-auditor` / You |
| R-1 | Medium | Odoo dispatch and mining moved to production 2026-09-23, same host/key as production/sales/purchases; app-side done, droplet `.env` + its own backfill still pending (re-scoped 2026-09-23) | You → whoever holds droplet SSH access |
| I-7 | Medium | No backups configured locally; droplet state unverified | `deployment-engineer` |
| I-2 | Medium | Quality KPI validated on 1 day of data vs. 91 for others | `kpi-data-analyst` |

Full log: [`RAID_LOG.md`](RAID_LOG.md) — 14 open, 2 assumptions, 4 closed/corrected.

## Go-live blockers owned outside this repo

- ~~**Lake Cement IT:** restrict the Graph app to `digital@lakecement.co.tz` with an application access policy~~ — **DONE, confirmed by Razak 2026-10-14.** The app can no longer send as any other mailbox, so the tenant-wide impersonation risk from the I-42 secret exposure is closed. Still outstanding from that exposure: **rotating the Graph client secret** (it was both in the publicly-readable `.env` and shared over chat). Note the mail route is settled — **Microsoft Graph, permanently; SMTP AUTH will not be enabled** (decided 2026-10-14), which is already how `services/mailer.js` is built, so no code change follows from it
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
