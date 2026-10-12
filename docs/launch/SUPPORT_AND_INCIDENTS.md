# Support & Incident Procedure — Nyati Cement MIS

**Version:** 1.0 · 2026-09-30

> ⚠️ **Placeholders in this document require confirmation before launch.**
> Support contacts, channel and hours are marked
> *[TO BE CONFIRMED]* and are not invented here. A support process with no
> named route is not a support process.

---

## 1. Issue categories

| Category | Description | Examples |
|---|---|---|
| **DATA** | A figure is wrong, missing or disputed | Dashboard disagrees with the source report; a KPI reads "no data" unexpectedly |
| **ACCESS** | Cannot log in, or cannot reach something they should | Locked out; "Access denied" on a page they need |
| **FUNCTION** | A feature does not work | Submit fails; export produces nothing |
| **PERFORMANCE** | Works but too slowly | A report takes minutes to load |
| **INTEGRATION** | Odoo or an external feed | Dispatch figures stale |
| **REQUEST** | A change or addition, not a fault | "Add a column for X" |
| **QUESTION** | How do I…? | Usually answered by the guides |

**Classify DATA issues first and treat them most seriously.** A wrong number
that reaches a management meeting causes a decision to be made on it.

---

## 2. Severity levels

| Severity | Definition | Response target | Resolution target |
|---|---|---|---|
| **P1 — Critical** | System unavailable, **or** a data-integrity problem: wrong figures published, data lost, or a permission boundary breached | *[TO BE CONFIRMED]* — recommend 30 min in working hours | Same day; escalate to MD if longer |
| **P2 — High** | Major function unavailable but the system is usable. Approvals blocked; a department cannot file; integration down >1 day | Recommend 4 working hours | 2 working days |
| **P3 — Medium** | A feature misbehaves and there is a workaround | 1 working day | Next release |
| **P4 — Low** | Cosmetic or usability | 3 working days | Backlog |

### The severity rule that matters

**A wrong number is P1, even if everything else works perfectly.**

A system that is fully available and shows incorrect figures is more
dangerous than one that is down, because nobody knows to stop trusting it.
This is the opposite of the usual instinct and it should be stated
explicitly to whoever triages.

### Not incidents

- A KPI reading "no data" because the report was not filed — that is a
  reporting gap. Route it to the department head, not to support.
- Email not arriving — a known open blocker (RAID R-6).
- A user being refused access their role does not include — that is the
  system working.

---

## 3. Escalation path

```
User
 └─► First line: [TO BE CONFIRMED]
      • Password/lockout, "how do I", known issues
      • Resolves or classifies within 1 working day
       └─► Department Head
            • Data disputes, missing reports, workflow questions
             └─► Technical owner (developer)
                  • Defects, integration, deployment, anything P1/P2
                   └─► Plant Head  ── business impact, adoption
                        └─► MD  ── extended outage, or a data-integrity
                                   issue that reached management reporting
```

**Anyone may escalate a suspected data-integrity problem straight to the
technical owner.** Do not make a user argue their way up a queue while wrong
figures stay published.

### Continuity risk

The system currently has **one** technical owner. For any P1 outside their
availability there is no second responder. Naming a backup with droplet
access is an operational requirement, not paperwork.

---

## 4. Bug report template

```
REPORT ID:        (assigned by support)
DATE/TIME:
REPORTED BY:      name, department, role (officer / senior / HOD / manager)

CATEGORY:         DATA / ACCESS / FUNCTION / PERFORMANCE / INTEGRATION / REQUEST / QUESTION
SUGGESTED SEVERITY: P1 / P2 / P3 / P4

WHERE:
  Page:
  Report type:
  REPORT DATE (the date the figures are FOR):     ← critical for DATA issues
  Browser/device:

WHAT HAPPENED:
  What I did:
  What I expected:
  What actually happened:
  Exact error text:

FOR DATA ISSUES — both figures, please:
  Figure shown by the system:
  Figure I believe is correct:
  Where my figure comes from (source report / workbook / weighbridge):

IMPACT:
  Who is affected:
  Can you work around it:
  Has this figure been used in a report or meeting:   ← decides severity

---- Support use ----
ASSIGNED TO:          SEVERITY CONFIRMED:
ROOT CAUSE:
RESOLUTION:
WHY TESTING MISSED IT:        ← mandatory for P1/P2
NEW CHECK ADDED:
RAID LOG ID:
CLOSED:
```

The line *"Has this figure been used in a report or meeting"* changes the
response: a wrong figure nobody has seen is a bug; a wrong figure already
quoted to management also needs a correction to those who received it.

---

## 5. Data correction procedure

**Never correct a figure by editing the database.** There are three
legitimate routes, depending on what is actually wrong.

### Case 1 — the report was filed wrongly

Route: **correction request** (see [User Guide](USER_GUIDE.md) §6).

1. Submitter requests a correction, with a reason
2. Department head grants it → a time-boxed window opens
3. Submitter corrects within the window
4. Prior figures are preserved in the revision log

No administrator or developer is needed. If the window lapses, the
grant-time figures are restored automatically and the request can be made
again.

### Case 2 — a monthly KPI figure is wrong and the month is locked

1. The head identifies the correct figure
2. An administrator or the MD reopens the month **with a written reason**
3. The head corrects and resubmits

The reason is permanently recorded. Write one that will make sense later.

### Case 3 — the report is right but the dashboard disagrees

**This is a defect, not a data correction. P1.**

1. **Do not change the report.** The report is the evidence
2. Capture both figures, the report type and the date
3. Escalate to the technical owner immediately
4. Determine how widely the wrong figure was published
5. Fix the calculation, then notify everyone who received the wrong number

Conflating Case 3 with Case 1 is the most damaging mistake available here:
"correcting" a correct report to match a broken calculation destroys the
real data and hides the defect.

---

## 6. Technical incident procedure

### P1 — system down or data integrity at risk

1. **Confirm scope** — one user, one department, or everyone?
   `curl -sS https://smr.lakecement.co.tz/api/health`
2. **Tell users** — a short honest notice, and whether to stop entering data
3. **Stabilise before diagnosing** — the technical owner may act without
   waiting for authorisation to restore service
4. **Preserve evidence** — capture logs and current figures *before*
   changing anything. A fix that erases the evidence guarantees a repeat
5. **Decide fix-forward or roll back** — see
   [`ROLLBACK_PLAN.md`](ROLLBACK_PLAN.md). Fix forward is usually safer;
   rollback involving a database restore needs authorisation
6. **Verify** — health check, log in, load a dashboard, confirm one figure
   against its source report
7. **Tell users it is resolved**, and say plainly whether any data was lost
8. **Write it up within 24 hours** (§7)

### P2 — major function unavailable

Confirm scope, publish a workaround if one exists, fix in the next release,
notify when resolved. No rollback unless it degrades to P1.

---

## 7. Post-incident review

Required for every P1 and P2, within 24 hours (P1) or 3 days (P2).

| Field | Notes |
|---|---|
| Incident ID | Sequential |
| Severity | |
| Detected by | A user or monitoring? **If a user, why not monitoring?** |
| Timeline | Detected → notified → mitigated → resolved |
| Users affected | |
| **Data affected** | Which reports and dates. "None" is a valid answer but must be stated |
| **Were wrong figures published?** | If yes: to whom, and were they corrected? |
| Root cause | The real one, not the first plausible one |
| **Why testing missed it** | **Mandatory** |
| **New gate added** | The test or check that would now catch it |
| RAID log entry | Permanent ID in `docs/pm/RAID_LOG.md` |

The last two rows are the point. This project's own history makes the case:
a full green unit-test suite once coexisted with a completely unbootable
application, and the fix was a new boot-dependent gate — not a resolution to
be more careful next time.

---

## 8. Change requests

A request for something new is not a bug. Keep the paths separate, or
genuine defects queue behind feature wishes.

```
CHANGE REQUEST
  Requested by:            Date:
  What you want:
  Why — what decision or task does it support:
  Who else needs it:
  What you do today instead:
  How urgent, and what drives that:

---- Assessment ----
  Affects data/KPI calculation:   YES / NO     ← if YES, needs a named business owner
  Affects permissions:            YES / NO     ← if YES, needs Plant Head approval
  Effort:                         Decision:
  Approved by:                    Target release:
```

**Any change to a KPI formula needs a named business owner**, because it
changes a number the plant reports. The heat-metric question (RAID I-36) is
a live example: two defensible definitions differ by ~11%, and a developer
must not pick one.

---

## 9. Known issues at launch

Tell users these, rather than letting them discover them:

| Issue | Status | User impact |
|---|---|---|
| **Email does not send** | Blocked at the mail tenant — needs IT | No reset links or invitations; administrators set passwords manually |
| **21 of 32 KPIs read "no data"** for Aug–Sep 2026 | Five reporting streams silent since 2026-06-30 | Expected, not a fault. Resolves as departments resume filing |
| **Dispatch tonnage not in KPIs** | 210 days held as draft — workflow decision open | Bags packed, burst bag rate and SO pendency read "no data" |
| **Quarry report slow** | Endpoint returns 12.67 MB | Slow page load |
| **Two heat figures** | Definition ruling pending | Do not quote heat consumption until resolved |
| **Backups on the app's own disk** | Being moved | Operational risk, not user-visible |

The full live register is `docs/pm/RAID_LOG.md`.

---

## 10. Support contacts

**All [TO BE CONFIRMED] before launch:**

| Route | Contact | Hours |
|---|---|---|
| First line | *[TO BE CONFIRMED]* | *[TO BE CONFIRMED]* |
| Technical owner | *[TO BE CONFIRMED]* | *[TO BE CONFIRMED]* |
| Out-of-hours P1 | *[TO BE CONFIRMED]* | — |
| Data disputes | The relevant Department Head | — |
| Access/accounts | System administrator | — |

Launching without these filled in means users have nowhere to go, and
problems get absorbed as workarounds instead of being reported — which is
how an MIS quietly stops being trusted.
