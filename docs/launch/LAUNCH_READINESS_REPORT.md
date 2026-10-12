# Launch Readiness Report — Nyati Cement Reporting & MIS

**Assessed:** 2026-09-30
**Assessor:** Lead Launch & Product Readiness review (evidence-based audit)
**Application:** Lake Cement Ltd / Nyati Cement internal reporting & MIS platform
**Live host:** `https://smr.lakecement.co.tz` (DigitalOcean droplet, nginx + pm2 + PostgreSQL)

---

## Evidence standard used in this report

Every claim below is tagged:

| Tag | Meaning |
|---|---|
| **VERIFIED** | A command was run in this audit and its real output is quoted |
| **INFERRED** | Read from code/config but not executed or observed live |
| **REQUIRES BUSINESS CONFIRMATION** | Cannot be determined from the repository — needs a human decision |

Nothing in this report is asserted from documentation alone. Where the
project's own docs disagreed with what the system actually does, the
observed behaviour wins and the discrepancy is noted.

---

## 1. EXECUTIVE SUMMARY

**The software is in materially better shape than the organisation's
readiness to use it.** This is the central finding, and it inverts the
usual launch problem.

The engineering is strong and unusually well evidenced. The full backend
test suite — 17 unit suites plus a boot-dependent smoke test — passes
green (**VERIFIED**, `npm test`). Authorization is genuinely enforced
server-side on 76 of 81 API endpoints, and the 5 that are open are exactly
the pre-login endpoints that must be (**VERIFIED**, static scan of
`backend/routes/`). HTTPS is live with a valid redirect
(**VERIFIED**, `http → 301 → https → 200`). The CI pipeline gates
deployment behind a full test + 10-suite acceptance run (**VERIFIED**,
`.github/workflows/deploy.yml`: `deploy` has `needs: test`). KPI
aggregation — the thing most likely to be silently wrong in a plant MIS —
is methodologically correct: **all 12 ratio KPIs (specific power, thermal
energy, heat rate, plant load factor, distribution loss) are
production-weighted, not averaged** (**VERIFIED**, registry inspection).
That is the single most common serious defect in this class of system, and
this codebase does not have it.

**What is not ready is the data pipeline's human half.** The system
computes 32 KPIs. For the current month and the one before it, **21 of
those 32 KPIs (66%) evaluate to `null` — "no data"** (**VERIFIED**,
`evalMonth()` replayed for 2026-05, 2026-08 and 2026-09). This is not a
calculation bug. It is that five of the nine daily reporting streams
stopped being filed after 30 June 2026:

| Report | Last month with data | Gap |
|---|---|---|
| Power consumption | 2026-06 | 3 months silent |
| Stoppage | 2026-06 | 3 months silent |
| Materials | 2026-06 | 3 months silent |
| Limestone | 2026-06 | 3 months silent |
| Quality | 2026-04 (1 day only) | effectively never |
| Dispatch | *every day present* — but all 210 rows are `draft`, so excluded from every KPI |

(**VERIFIED**, coverage grid query against `daily_reports`.)

Launching an MIS to senior management in which two thirds of the headline
KPIs read "no data" would damage confidence in the system permanently, and
that damage is very hard to reverse. **The blocker is reporting discipline
and a workflow decision on dispatch, not code.**

The second gap is documentation. The repository holds 15 substantial
documents — but every one is an engineering or project-management artifact.
**There is no user guide, no manager guide, no administrator guide, and no
training material of any kind** (**VERIFIED**, `docs/` inventory and
keyword search). Staff cannot be asked to adopt a system nobody has written
instructions for.

**Recommendation: GO WITH CONDITIONS** — see §15. The conditions are
achievable in roughly three to four weeks and are mostly organisational,
not technical.

---

## 2. LAUNCH READINESS SCORECARD

| Area | Status | Basis |
|---|---|---|
| Backend platform & boot | **READY** | `npm test` 17 suites + smoke green; live `/api/health` responds |
| Authentication | **READY** | JWT + server-side revocation, token_version, sliding session, lockout, rate limiting — all verified in code and one live test |
| Authorization (RBAC) | **READY** | 76/81 endpoints guarded; live access matrix generated from real middleware |
| KPI calculation & aggregation | **READY** | 32 formulas; all 12 ratio KPIs production-weighted; 6 self-flagged provisional |
| HTTPS / transport security | **READY** | 301→200 verified live; HSTS present on API |
| Static-page security headers | **NEEDS WORK** | nginx applies no CSP/HSTS/X-Frame-Options to HTML pages — only `/api/*` is protected |
| CI/CD gate | **READY** | `deploy` blocked behind `needs: test` |
| Database schema & migrations | **READY** | 30 sequential migrations, runner in deploy path |
| Database backups | **NEEDS WORK** | Running, but **on the same disk as the app** — live health reports this as a warning |
| **Daily reporting data coverage** | **BLOCKED** | **5 of 9 streams silent since 2026-06-30; 21/32 KPIs null** |
| **Dispatch data pipeline** | **BLOCKED** | 210 days of real tonnage held as `draft`, invisible to every KPI |
| Heat/coal metric definition | **NEEDS WORK** | Two different coal fields produce ~11% divergent heat figures (RAID I-36) |
| Quarry tickets endpoint | **NEEDS WORK** | Unbounded — **12.67 MB / 49,559 rows** measured this audit |
| Report write-lock & audit trail | **READY** | Append-only revisions, 409 lock, correction-request workflow, all tested |
| Odoo integration | **READY WITH MINOR FIXES** | 3 pulls live and fresh (< 3 min old at audit time); 2 field-mapping gaps open |
| Export functionality | **NOT VERIFIED** | Excel export layer has 32 tests, but no end-to-end export was executed in this audit |
| Browser/responsive/a11y | **READY** | Project's own harness: 88/88 responsive, 0 a11y violations (not re-run here) |
| **User documentation** | **BLOCKED** | **None exists — 0 of 4 required guides** |
| **Training material** | **BLOCKED** | **None exists** |
| Support & incident process | **NEEDS WORK** | No defined severity model, intake route or escalation path |
| Email / notifications | **BLOCKED** | Tenant blocks SMTP AUTH (RAID R-6) — owned by Lake Cement IT |
| Go/no-go governance | **NEEDS WORK** | RACI exists but Plant Head and MD are unconfirmed placeholders |

---

## 3. CRITICAL BLOCKERS — must resolve before launch

### B-1 — Two thirds of KPIs show "no data" *(Highest severity)*

**VERIFIED.** For 2026-08 and 2026-09, 21 of 32 KPIs return `null`,
including every headline efficiency metric: specific thermal energy,
all three specific-power KPIs, power distribution loss, total power,
total and kiln stoppage minutes, clinker/gypsum/coal consumption, and
all lab quality parameters.

**Cause:** the power-cons, stoppage, materials, limestone and quality
daily reports have had no submissions since 30 June 2026 (quality since
21 April). Production and CPP are still being filed; the rest are not.

**Risk:** this is the launch-credibility risk. Management opening the MIS
on day one and seeing "no data" across most of the dashboard will conclude
the system does not work. That judgement, once formed, is extremely
expensive to reverse.

**Required action:** before launch, either (a) backfill the July–September
gap from the plant's source workbooks, which is how April–June was
populated, or (b) explicitly scope the launch to the modules that do have
live data (Production, CPP, Dispatch, Sales, Purchases, Quarry) and
present the others as "starting now" rather than as broken history.
**This is a business decision — see D-1 in §13.**

**Owner:** Plant Head + department HODs (reporting discipline);
developer (backfill execution, if chosen).

---

### B-2 — 210 days of real dispatch tonnage reach no KPI

**VERIFIED.** Every dispatch day from 2026-03-01 to 2026-09-30 exists in
the database with real Odoo tonnage (e.g. 2026-09-28 carries
`dispatch_reg_425r` = 2,069 MT), but all 210 rows are `status='draft'`,
and drafts are correctly excluded from all reporting. Consequence:
`bags-packed`, `burst-bag-rate` and `so-pendency` have read `null` since
March, and the completeness heatmap shows dispatch as absent on days it
has a row for.

This is a *deliberate* design trade-off (migration 030: `draft` keeps the
Odoo-written day writable so an officer can add the manual-only fields —
SO pendency, bags packed, burst bags, vehicle queue). The cost was not
intended to be this large.

**Required action — pick one:**
- **(a)** Dispatch/Packing work the backlog so days get submitted, as was
  done for the 78 production drafts; or
- **(b)** Change the autofill to land dispatch days as `pending_approval`
  and accept that the manual-only fields stay empty.

Doing neither leaves seven months of real tonnage outside every reported
number. **Business decision — D-2 in §13.**

---

### B-3 — No user-facing documentation exists

**VERIFIED.** `docs/` contains 15 files, all engineering/PM artifacts
(access model, deployment, KPI reference, technical spec, design system,
RAID log, etc.). A keyword search for user-guide or training content
returns nothing.

Staff, HODs and management cannot be asked to adopt a system with no
instructions. **Four guides are required before launch** — see §6 and the
drafts delivered alongside this report.

**Owner:** developer (authoring), HODs (review for accuracy).

---

### B-4 — Static pages carry no security headers

**VERIFIED.** `/api/health` returns a full helmet header set (CSP, HSTS,
X-Frame-Options, Referrer-Policy). `/login.html` returns only
`X-Content-Type-Options: nosniff`, because nginx serves the HTML directly
and never passes through Express.

**Risk:** the login page and every dashboard can be framed (clickjacking),
have no CSP, and no HSTS. A credential-entry page is exactly the page that
most needs these.

**Required action:** add the header block to
`deploy/nginx.digitalocean.conf`. This is a small, low-risk, high-value
fix — a genuine launch blocker that costs about ten minutes.

**Owner:** developer / deployment.

---

### B-5 — Backups are on the same disk as the application

**VERIFIED, live.** `/api/health` on production returns:

```
"backup":{"ok":false,"age_hours":8,"max_hours":26,"same_disk_as_app":true,
"warning":"BACKUP_DIR appears to be on the same disk as the app"}
```

Backups *are* running (8 hours old, within tolerance). But they are on the
same volume as the data they protect, so the single most likely disaster —
volume loss — destroys both. There is also **no evidence in this audit of a
successful restore ever having been performed** against production.

**Required action:** point `BACKUP_DIR` at DigitalOcean Spaces or a second
volume, and perform one documented restore drill before launch. A backup
that has never been restored is a hypothesis, not a backup.

**Owner:** developer / deployment.

---

## 4. REMAINING WORK — should fix before launch

| ID | Item | Evidence | Why it matters |
|---|---|---|---|
| S-1 | **Heat metric defined two ways** (RAID I-36) | Two coal fields, ~11% / ~100 kcal/kg divergence every day; MIS pack prints one under a label the STE tile derives from the other | Two different official heat numbers in one document destroys trust in both. **Needs a process engineer's ruling, not a code choice** |
| S-2 | **Quarry endpoint unbounded** (RAID I-19) | **12.67 MB, 49,559 rows** measured this audit; no `LIMIT`, no pagination | Every `mines-report.html` load pulls the entire ticket history. Will degrade continuously as tickets accrue |
| S-3 | **Email cannot send** (RAID R-6) | Tenant returns `535 SmtpClientAuthentication is disabled` | Invites, password resets and the morning digest all silently fail. Blocks self-service onboarding. **Owned by Lake Cement IT** |
| S-4 | **`openpg` may hold its default password** (RAID R-4) | Unverifiable from this repo | Odoo-bundled Postgres credential exposure |
| S-5 | **Export path never executed end-to-end** | Excel layer has 32 unit tests; no live export run in this audit | Exports are a management-facing feature; untested in anger |
| S-6 | **Digest/alert recipients undefined** (RAID D-2) | `DIGEST_TO` empty | Alerts fire into a void |
| S-7 | Odoo field-mapping gaps (I-24, I-26, I-32) | MG-HG tonnage excluded; `QRM008` unmapped; one 30 MT bulker discrepancy | Small but real tonnage invisible in Quarry/MIS totals |
| S-8 | RACI has unconfirmed placeholders | Plant Head and MD named as *pending confirmation* | No named authority to sign the go/no-go |

---

## 5. WHAT IS VERIFIED CORRECT — do not "fix" these

Recording this deliberately, because a later reviewer may be tempted to
change them:

1. **Ratio aggregation is correct.** All 12 ratio KPIs use
   production-weighted means, computed from monthly totals rather than by
   averaging daily ratios. `specific-power-consumption-total` etc. are
   right.
2. **The 13 `avg` KPIs are correct too.** Each is either a lab parameter
   (free lime, C₃S, Blaine, CaO, 28-day strength) where an unweighted mean
   of samples is the right method, or a per-day quantity with a per-day
   target (kiln output vs ≥2,000 MT/day; bags packed vs ≥7,000/day), where
   a monthly sum would be meaningless against the target. `so-pendency` is
   explicitly and correctly handled as a **stock, not a flow**.
3. **Draft exclusion is correct.** `REPORTED_STATUSES` excluding drafts and
   rejected reports is right; B-2 is a workflow problem, not a reason to
   count drafts.
4. **The day, not the shift, is the unit of evaluation.** This was fixed
   deliberately (I-34) and prevents `evalMonth()` and `evalDaily()`
   disagreeing.
5. **6 KPIs self-declare as provisional** with written reasons, and the UI
   can surface those notes. This is honest instrumentation — keep it.
6. **Null means "no data", never zero.** Fixed under I-33/I-35. A fabricated
   zero on an efficiency KPI reads as perfection; this codebase now refuses
   to do that.

---

## 6. DOCUMENTATION PACKAGE — status

| # | Document | State |
|---|---|---|
| 1 | Launch Readiness Report | **This document — delivered** |
| 2 | Launch Plan | Delivered — `LAUNCH_PLAN.md` |
| 3 | Deployment Runbook | Partly exists (`docs/DEPLOYMENT_DIGITALOCEAN.md`) — launch-day sequence added to Launch Plan |
| 4 | Rollback Plan | Delivered — `ROLLBACK_PLAN.md` |
| 5 | UAT Plan + Test Cases | Delivered — `UAT_PLAN.md` |
| 6 | User Guide | Delivered — `USER_GUIDE.md` |
| 7 | Manager Guide | Delivered — `MANAGER_GUIDE.md` |
| 8 | Administrator Guide | Delivered — `ADMINISTRATOR_GUIDE.md` |
| 9 | Technical Documentation | **Already strong** — `docs/TECHNICAL_SPEC.md` + `docs/KPI_REFERENCE.md`. Not duplicated |
| 10 | KPI Data Dictionary | **Already exists and is byte-current** — `docs/KPI_REFERENCE.md`, generated from the live registry by `npm run docs:kpi`. Not duplicated |
| 11 | Role & Permission Matrix | **Already exists and is executable** — `docs/ACCESS_MODEL.md` + `npm run access:matrix`. Not duplicated |
| 12 | Business Process Documentation | Delivered — in Launch Plan §Business Process |
| 13 | Training Plan | Delivered — in Launch Plan |
| 14 | Support & Incident Procedure | Delivered — `SUPPORT_AND_INCIDENTS.md` |
| 15 | Communication Pack | Delivered — `COMMUNICATIONS.md` |
| 16 | Risk Register | This report §3–4 + existing `docs/pm/RAID_LOG.md` (52 KB, live) — not duplicated |
| 17 | Known Issues Register | `docs/pm/RAID_LOG.md` — already serves this purpose |
| 18 | Go/No-Go Checklist | Delivered — in Launch Plan |

**Deliberately not created**, with reason:
- **KPI Data Dictionary, Role/Permission Matrix, Technical Spec** —
  already exist, are current, and two of them are *generated from live
  code*, which makes them more trustworthy than anything hand-written.
  Duplicating them would create a second version that drifts.
- **Change Request Template / Post-Launch Review Template** — folded into
  the Support and Launch Plan documents rather than issued as standalone
  near-empty forms.

---

## 7. FINAL RECOMMENDATION

# GO WITH CONDITIONS

**Evidence supporting this status:**

The platform itself passes every technical gate that can be tested from
this repository: full test suite green, 76/81 endpoints authorization-
guarded, HTTPS live, CI gate effective, migrations sequential and
automated, an append-only audit trail on report writes, and — critically
for a plant MIS — KPI aggregation that is methodologically correct where
it most often is not. There is no evidence of a defect that would corrupt
or lose business data.

**It is not a GO**, because launching now would put a dashboard in front of
senior management where 21 of 32 KPIs read "no data", seven months of real
dispatch tonnage are invisible, staff have no instructions of any kind, the
login page has no clickjacking or transport-security headers, and backups
have never been demonstrated to restore.

**It is not a NO-GO**, because none of those are deep technical problems.
Four of the five blockers are days of work or a single management decision.

**The conditions are the five blockers in §3.** B-4 and B-5 are short
technical tasks. B-3 is authoring, largely delivered with this package.
B-1 and B-2 are business decisions that need the Plant Head — and they are
the ones that actually determine the launch date.

---

*Prepared 2026-09-30. Every VERIFIED claim is reproducible with the command
named beside it.*
