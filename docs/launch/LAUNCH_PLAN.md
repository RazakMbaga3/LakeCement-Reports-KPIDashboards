# Launch Plan — Nyati Cement Reporting & MIS

**Version:** 1.0 · **Date:** 2026-09-30
**Companion to:** `LAUNCH_READINESS_REPORT.md` (read that first)
**Status of this plan:** proposed — dates require Plant Head / MD approval

---

## 1. Where the system is starting from

The application is **already deployed and running** at
`https://smr.lakecement.co.tz`, with live Odoo integrations pulling every
30 minutes and 43 user accounts provisioned. This is therefore not a
"first deployment" launch. It is a **transition from developer-operated
system to organisationally-owned system**.

That distinction shapes the whole plan: the technical cutover is small; the
adoption work is large.

---

## 2. Phase sequence

```
NOW ─────────► VALIDATION ───► PILOT ───► UAT SIGN-OFF ───► PRODUCTION ───► ORG-WIDE ───► SUPPORT
            (blockers +      (2 depts,   (role-by-role    (full user     (all depts)   (steady
             docs + data)     2 weeks)    acceptance)      enablement)                  state)
```

| Phase | Duration | Exit condition |
|---|---|---|
| **0 — Validation** | ~2 weeks | All five §3 blockers closed or formally accepted by the Plant Head |
| **1 — Pilot** | 2 weeks | Two departments filing daily, unassisted, for 10 consecutive working days |
| **2 — UAT** | 1 week | Every UAT case in `UAT_PLAN.md` executed and signed by a real user per role |
| **3 — Production launch** | 1 day | Smoke tests pass; all users enabled; announcement issued |
| **4 — Org-wide adoption** | 4 weeks | ≥90% on-time submission across all reporting departments |
| **5 — Post-launch support** | ongoing | Support process operating per `SUPPORT_AND_INCIDENTS.md` |

---

## 3. Phase 0 — Validation (the critical path)

Ordered by what blocks what. Technical items first because they are cheap
and unblock confidence; data and decisions run in parallel because they
depend on other people.

### Technical track (developer-owned, ~2 days total)

| # | Task | Blocker | Verification |
|---|---|---|---|
| T1 | Add security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy) to nginx for static pages | B-4 | `curl -I https://smr.lakecement.co.tz/login.html` shows the full set |
| T2 | Move `BACKUP_DIR` to a second volume or DO Spaces | B-5 | `/api/health` no longer reports `same_disk_as_app: true` |
| T3 | **Perform and document one full restore drill** | B-5 | Restored DB row counts match source; written result recorded |
| T4 | Bound `GET /api/quarry/tickets` — server-side aggregation or pagination | S-2 | Response < 500 KB for a normal page load |
| T5 | Execute one end-to-end export of each export type | S-5 | Files open in Excel; totals match the on-screen figures |

### Data track (departments + developer)

| # | Task | Blocker | Owner |
|---|---|---|---|
| D-T1 | Decide: backfill Jul–Sep for the 5 silent streams, **or** scope launch to live modules only | B-1 | **Plant Head** |
| D-T2 | Decide dispatch: work the 210-day backlog, **or** land Odoo days as `pending_approval` | B-2 | **Plant Head + Logistics/Packing HOD** |
| D-T3 | Rule on the heat/coal definition (`coal_kiln` vs `coalmill_cons_mt`) | S-1 | **Production / process engineer** |
| D-T4 | Restore daily filing for power-cons, stoppage, materials, limestone, quality **from a named date forward** | B-1 | Department HODs |

### Organisational track

| # | Task | Blocker | Owner |
|---|---|---|---|
| O1 | Review and approve the four user-facing guides | B-3 | HODs (accuracy) + Plant Head (tone) |
| O2 | Confirm Plant Head and MD as named launch authorities | S-8 | **MD** |
| O3 | Enable SMTP AUTH for `digital@lakecement.co.tz`, or move to Graph API | S-3 | **Lake Cement IT** |
| O4 | Name digest and alert recipients | S-6 | **Plant Head / Management** |
| O5 | Rotate the `openpg` Postgres password | S-4 | Whoever administers the Odoo-bundled Postgres |

**Phase 0 exits when every blocker is either closed or has a written
acceptance from the Plant Head.** "Accepted" is a legitimate outcome — for
example, launching with quality KPIs empty is defensible if it is a
conscious decision, communicated in the launch message. What is not
defensible is launching without anyone having decided.

---

## 4. Phase 1 — Pilot design

### Recommended pilot group

**REQUIRES BUSINESS CONFIRMATION — no individuals are named here, because
the repository does not contain the staff roster.** The recommendation is
by *department*, chosen on evidence:

| Pilot department | Why this one |
|---|---|
| **Production** | Already filing daily through September (**VERIFIED**: 17 days in 2026-09). The only stream with unbroken recent history — so the pilot tests adoption, not backfill |
| **Power Plant (CPP)** | Also still filing (**VERIFIED**: 15 days in 2026-09), and exercises a different form, a different HOD and the L1/L2/L3 level split |

**Deliberately excluded from the pilot:** Dispatch (blocked on the B-2
decision), and the four silent streams (they need filing restored before
they can be piloted).

### What the pilot must exercise

Real users, real reports, real deadlines, real management consumption — not
a sandbox:

- An L3 officer fills and submits → lands `pending_approval`
- The L1 HOD reviews and approves → figure enters the KPIs
- A mistake is made and corrected through the **correction-request
  workflow** (not by a developer touching the database)
- The HOD views the KPI dashboard and confirms the number matches what was
  filed
- Management opens the MIS dashboard and sees the pilot departments' data
- One deliberate late submission, to confirm the missed-entry alert fires
  and reaches someone

### Pilot success criteria

| Criterion | Target |
|---|---|
| Days filed on time | ≥ 8 of 10 working days, per department |
| Submissions needing developer intervention | 0 |
| Data disputes (figure on dashboard ≠ figure filed) | 0 |
| Corrections completed through the in-app workflow | 100% of corrections needed |
| P1/P2 incidents | 0 |
| HOD confirms the dashboard is usable without help | Both HODs, in writing |

### Go/no-go from pilot to full launch

**GO** if: all six criteria met, and no unresolved P1/P2.
**HOLD** if: submissions require help, or any figure disputed.
**ROLL BACK** if: a data-integrity defect is found — see `ROLLBACK_PLAN.md`.

---

## 5. Business process documentation

This is the operational process *around* the software. Items marked
**BUSINESS DECISION REQUIRED** cannot be determined from the codebase and
must not be guessed.

### What the code does tell us (VERIFIED)

| Question | Answer from code |
|---|---|
| Who submits daily reports? | L2/L3 department users — submission lands `pending_approval` |
| Who approves? | The owning department's L1 HOD only, and never the person who submitted (separation of duties is enforced) |
| Which department owns which report? | Declared in `forms/access-registry.js`; printable via `npm run access:matrix` |
| Who submits monthly KPIs? | The department L1 HOD; the month then locks |
| Who can reopen a locked month? | admin/MD only, with a mandatory written reason ≥10 characters, recorded in `audit_log` |
| Can an approved report be silently edited? | **No** — returns `409 REPORT_LOCKED`; changes require a correction request, and prior figures are preserved in `report_revisions` |
| Who sees the MIS dashboard? | `management`, `md`, `admin` only |
| Who sees System Monitor? | `admin`, `md`, `it` only — enforced server-side |
| Is a missed report detected? | Yes — a watchdog raises `missed-entry:<form>` daily |

### What the code cannot tell us

| Question | Status |
|---|---|
| **When is each daily report due?** | **BUSINESS DECISION REQUIRED.** A cutoff exists as config (`MISSED_ENTRY_CUTOFF`) but no organisational deadline is documented |
| **What happens when a report is late?** | **BUSINESS DECISION REQUIRED.** The system raises an alert; no consequence or escalation is defined |
| **Who resolves a data dispute?** | **BUSINESS DECISION REQUIRED.** RACI proposes the disputing department is consulted and the developer is accountable — needs ratifying |
| **Who approves a change to a KPI formula?** | **BUSINESS DECISION REQUIRED.** RACI proposes MD consulted for headline KPIs |
| **Who owns the system after handover?** | **BUSINESS DECISION REQUIRED.** Currently a single developer is sole operator — a continuity risk |
| **Who receives alerts and the morning digest?** | **BUSINESS DECISION REQUIRED** (RAID D-2) |

---

## 6. Training plan

Three audiences, three different sessions. Keep them short — plant staff
will not attend a two-hour software course.

### Session A — Regular users (L2/L3 officers) · 45 min · per department

| Segment | Time | Content |
|---|---|---|
| Logging in | 5 min | URL, first-password change, what to do when locked out |
| Filling your report | 20 min | Live walkthrough of *their own* form — not a generic one |
| Save Draft vs Submit | 5 min | The single most important distinction: a draft is **not** reported data |
| Checking status | 5 min | Where to see draft / pending / approved / rejected |
| Fixing a mistake | 10 min | Before approval: edit. After approval: request a correction — **never ask a developer** |

Deliverable: one-page quick reference per department, showing that
department's own form.

### Session B — Managers & HODs · 60 min

| Segment | Time | Content |
|---|---|---|
| Approving reports | 15 min | The queue, what approval means, why you cannot approve your own |
| Monthly KPI submission | 10 min | Submitting, and that it locks afterwards |
| Reading the dashboards | 20 min | KPI cards, trends, target vs actual |
| Spotting exceptions | 10 min | Missing reports, "no data" vs zero, provisional KPIs |
| Exports | 5 min | Getting figures into Excel for meetings |

**Emphasise:** "no data" and "0" mean different things, and a KPI flagged
*provisional* has a written caveat that must be read before it is quoted in
a meeting.

### Session C — Administrators · 90 min

Creating and deactivating users, roles and levels, reopening a locked KPI
month (and why the reason is mandatory), the System Monitor, reading
`/api/health`, Odoo sync state, backups and restore, and the escalation
path. Plus: what an administrator must **not** do — edit figures directly
in the database.

### Supporting material

- Four guides in this package (user, manager, administrator, technical)
- One-page quick-reference cards per department — **to be produced after
  the guides are reviewed**
- FAQ — grown from real pilot questions, not invented in advance
- Screenshots — **to be captured from the live system during the pilot**,
  once the UI is final. No fabricated screenshots are included in this
  package.

---

## 7. Launch-day runbook

### T-7 days

- [ ] Final UAT pass complete and signed (`UAT_PLAN.md`)
- [ ] All five blockers closed or formally accepted in writing
- [ ] Documentation reviewed and approved by HODs
- [ ] Training delivered to every pilot department
- [ ] User list confirmed — every account maps to a real named person
- [ ] Support intake route live and communicated

### T-3 days

- [ ] Production readiness review (this report re-checked)
- [ ] **Full database backup taken and verified restorable**
- [ ] Deployment rehearsed on a non-production target
- [ ] Odoo integrations confirmed fresh: `/api/health` → all `sync` entries `ok`
- [ ] Rollback plan reviewed; rollback authority named

### T-1 day

- [ ] Final data validation: spot-check 3 KPIs against their source reports
- [ ] Confirm no test or demo data is present in production
- [ ] Communications approved and queued (`COMMUNICATIONS.md`)
- [ ] Support cover confirmed for launch day and day +1

### Launch day

| Time | Action | Verification |
|---|---|---|
| Start | Take a fresh backup | Backup file exists off-app-disk |
| +10 min | Deploy (push to `main`; CI gates on tests) | GitHub Actions `test` job green before `deploy` runs |
| +20 min | Smoke test: `/api/health` | `status` not `unhealthy`; `db.ok: true` |
| +25 min | Log in as one account per role | Each lands on its correct home page |
| +35 min | Submit one real report end to end | Appears in the approval queue |
| +45 min | Approve it | Figure appears on the KPI dashboard |
| +55 min | Open MIS dashboard as management | Values match the source report |
| +60 min | Run one export | File opens; totals match screen |
| +70 min | Confirm Odoo sync freshness | `last_success_min_ago` < 60 |
| +90 min | Issue launch announcement | — |
| Rest of day | Monitor `/api/health`, error reports, submissions | No P1; submissions arriving |

**Note:** the deployment sequence is `git push origin main` → GitHub Actions
runs `npm test` plus 10 acceptance suites → on green, SSHs to the droplet
and runs `deploy/deploy.sh` (`git reset --hard origin/main`,
`npm ci --omit=dev`, `npm run migrate`, `pm2 reload`). **These are the
project's real commands, read from `.github/workflows/deploy.yml` and
`deploy/deploy.sh` — not invented.**

### T+1 day

- [ ] Review every issue raised on day one
- [ ] Check adoption: who filed, who did not
- [ ] Validate that yesterday's submissions reached the KPIs correctly
- [ ] Resolve or escalate all P1/P2

### T+7 days

- [ ] Adoption review: submission rate by department
- [ ] Data quality review: corrections requested, disputes raised
- [ ] User feedback gathered from each role
- [ ] Performance review: `/api/health` history, page load complaints
- [ ] Improvement backlog prioritised

### T+30 days

- [ ] On-time submission rate trend
- [ ] Are managers actually using the dashboards, or still asking for Excel?
- [ ] Monthly KPI cycle completed once, end to end, by every department
- [ ] Decide which deferred items (§4 of the readiness report) now matter

---

## 8. Launch success metrics

No baseline values are invented — each is measured from launch day forward.

| Metric | How it is measured | Why |
|---|---|---|
| User activation | Accounts that have logged in at least once ÷ accounts created | Provisioned ≠ adopted |
| Submission rate | Reports filed ÷ reports expected, by department | The core adoption signal |
| On-time submission rate | Filed before the agreed cutoff ÷ expected | Needs the deadline decision first |
| Missing report rate | `missed-entry` alerts per week | Should trend down |
| KPI completeness | KPIs with a value ÷ 32 | **Currently 11/32 for the live month** — the headline number to move |
| Correction requests | Count, and time to resolve | Healthy if low and falling |
| Data disputes | Figures challenged by a department | Should be ~0; each one is a trust event |
| System uptime | `/api/health` availability | — |
| Support incidents | By severity, per week | — |
| Manager dashboard usage | Distinct management logins per week | Tests whether the MIS is actually consumed |

---

## 9. Launch governance

| Role | Responsibility | Who |
|---|---|---|
| **Business owner / launch authority** | Approves go/no-go; owns adoption | **Plant Head** — *name REQUIRES CONFIRMATION* |
| **Executive sponsor** | Owns the cutover decision and funding | **MD** — *name REQUIRES CONFIRMATION* |
| **Technical owner** | Code, deployment, data integrity | Developer (`razakmbaga3@gmail.com`) |
| **System administrator** | Users, roles, monitoring | *REQUIRES CONFIRMATION — currently the developer, which is a continuity risk* |
| **Department representatives** | Own their department's figures | Each HOD |
| **Support** | First-line intake | *REQUIRES CONFIRMATION* |

### RACI for launch decisions

R = Responsible · A = Accountable · C = Consulted · I = Informed

| Decision | Developer | Plant Head | MD | HODs | IT |
|---|---|---|---|---|---|
| Go/no-go to launch | C | **A** | C | C | I |
| Scope the launch (which modules) | C | **A** | I | C | — |
| Backfill vs launch-forward (B-1) | C | **A** | I | C | — |
| Dispatch workflow (B-2) | C | **A** | I | **C** | — |
| Heat metric definition (S-1) | C | A | I | **R** (Production) | — |
| Rollback during launch | **R** | A | I | I | I |
| Security fixes | **R,A** | I | — | — | C |
| SMTP enablement | C | I | — | — | **R,A** |

---

## 10. Go / No-Go checklist

Launch requires **every MUST row** to be YES, or to carry a written
acceptance from the launch authority.

### MUST FIX BEFORE LAUNCH

| # | Gate | Status now |
|---|---|---|
| 1 | Static pages carry security headers | ❌ **NO** |
| 2 | Backups off the application disk | ❌ **NO** |
| 3 | One successful documented restore drill | ❌ **NO** |
| 4 | User + manager + admin guides reviewed and approved | ⚠️ Drafted, not reviewed |
| 5 | KPI "no data" position decided and communicated (B-1) | ❌ **Decision open** |
| 6 | Dispatch pipeline decision made (B-2) | ❌ **Decision open** |
| 7 | Full test suite green | ✅ **YES** (verified) |
| 8 | Authorization enforced server-side | ✅ **YES** (76/81 verified) |
| 9 | HTTPS live | ✅ **YES** (verified) |
| 10 | No test/demo data in production | ⚠️ Not verified in this audit |
| 11 | Named launch authority | ❌ **NO** (placeholders) |
| 12 | Support intake route defined | ⚠️ Drafted, not staffed |

### SHOULD FIX BEFORE LAUNCH

| # | Gate |
|---|---|
| 13 | Heat metric ruling (S-1) |
| 14 | Quarry payload bounded (S-2) |
| 15 | Email sending works (S-3) |
| 16 | `openpg` password rotated (S-4) |
| 17 | Export verified end to end (S-5) |
| 18 | Alert recipients named (S-6) |

### CAN FIX AFTER LAUNCH

Odoo field-mapping gaps (I-24/I-26/I-32, small tonnage) · flaky
e2e spec (I-21) · minor UI inventory findings · quality KPI single-day
validation (I-2) · deferred stale-while-revalidate caching.

### BUSINESS DECISION REQUIRED

See §5 and §13 of the readiness report — 10 items, none of which a
developer may decide alone.

---

*This plan contains no invented dates, names, URLs or contacts. Every
placeholder is marked. Every command quoted was read from the repository.*
