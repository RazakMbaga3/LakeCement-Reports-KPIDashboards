# Manager Guide — Nyati Cement Reporting & MIS

**For:** department heads, managers and senior management
**Version:** 1.0 · 2026-09-30

Read the [User Guide](USER_GUIDE.md) first if you also enter reports. This
guide covers what you do *in addition*: approving, monitoring, and reading
the numbers.

---

## 1. What you are accountable for

The system enforces one rule above all others: **the person who reports a
figure is never the person who signs it off.** When you approve a report,
you are certifying your department's figures. They then flow into the KPIs,
the MIS dashboard, and the reports senior management reads.

Two practical consequences:

- If you approve carelessly, wrong figures reach management with your
  approval on them.
- If you do not approve at all, your department's figures **do not exist**
  as far as the plant's records are concerned.

The second failure is quieter than the first, and currently more common.

---

## 2. Approving reports

1. Go to **Approvals**.
2. The queue shows only reports **you** are the approver for — you will
   never be shown something you would then be refused.
3. Open a report, review the figures, and **Approve** or **Reject**.
4. Rejecting requires a reason. The submitter sees it and can correct and
   resubmit.

### What to actually check before approving

Not every field — you would never approve anything. Check the things that
matter and the things that are easy to get wrong:

| Check | Why |
|---|---|
| Does production tonnage look like a normal day? | A decimal point in the wrong place is the most common serious error |
| Are the big consumption figures plausible — coal, power? | These drive the efficiency KPIs management watches |
| Is anything blank that is normally filled? | A blank becomes "no data" and puts a hole in the monthly figure |
| Is the **date** right? | A report filed against the wrong date corrupts two days at once |

If something looks wrong, **reject it with a reason** rather than approving
it and mentioning it later. Rejection is a normal part of the process, not
a criticism.

### If you are a department head filing your own report

Your submission is approved as you file it — you are signing your own
figures. There is nobody else to check them, so check them yourself.

---

## 3. Monitoring submissions — finding what is missing

This is the part of your job the system is best at helping with, and the
part most easily neglected.

**Entry Summary** and the completeness view show which reports have been
filed and which have not. A day with no report shows as **missing**, not as
zero.

### What to look for each week

| Signal | What it means |
|---|---|
| A day showing as missing | Nobody filed it. It will never appear on its own |
| A report sitting at **Pending approval** for days | It is waiting for *you*. Its figures are not in the KPIs yet |
| A report sitting at **Draft** | The officer filled it and never submitted it. **The figures exist but count for nothing** |
| A KPI reading "no data" for the whole month | The whole reporting stream has stopped |

**The draft case is the one to watch.** An officer who saves a draft and
goes home believes the report is filed. It is not. Only you will notice.

### Current state you should know about (as at 2026-09-30)

Five reporting streams have had no submissions since **30 June 2026**:
power consumption, stoppage, materials, limestone, and quality. As a result
**21 of the 32 KPIs read "no data" for August and September.**

Dispatch is a different case: every day is present with real tonnage, but
all of it is held as draft, so none of it reaches any KPI.

This is a reporting-discipline gap, not a software fault. If your
department is one of those five, restoring daily filing is the single most
valuable thing you can do for this system.

---

## 4. Monthly KPI submission

1. Go to **KPI**, choose your department and the month.
2. Enter targets and actuals.
3. **Submit** when the month is complete.

**Submitting locks the month.** Afterwards, only an administrator or the MD
can reopen it, and they must record a written reason. This is intentional:
a monthly figure that has gone to management should not change without a
trace.

Check before you submit. An empty month will be refused.

---

## 5. Reading the dashboards

### Where things are

| Page | What it gives you |
|---|---|
| **Executive Summary** | The headline view across the plant |
| **Operational Summary** | Day-to-day operational performance |
| **Power & Heat** | Energy and thermal efficiency |
| **Equipment Reliability** / **Stoppage Insights** | Downtime, availability, MTBF, Pareto of causes |
| **Analytics** | Trends over any date range |
| **MIS Dashboard** | The cross-department management pack *(management, MD and admin only)* |
| **MIS Reports & Exports** | Getting figures out into Excel |
| **Plant Memory Search** | Searching the reporting history |

### Three rules for reading these numbers honestly

**1. "No data" is not zero.**
If a KPI shows *no data*, the underlying report was not filed. The system
deliberately refuses to print a 0, because a 0 on an efficiency KPI reads
as perfect performance. Never interpret a blank as good news.

**2. "Provisional" means read the note first.**
Six KPIs carry a written caveat about how they are calculated — for
example, the specific-power figures currently understate true consumption
because Compressed Air/Utilities stopped being captured in July 2026.
**Read the note before quoting the number in a meeting.**

**3. Monthly ratios are calculated properly — trust them.**
Specific Power Consumption for a month is *total energy ÷ total
production*, not the average of the daily ratios. Those give different
answers, and the second one is wrong. This system does it the right way, so
the monthly figure is comparable against the target.

Note the corollary: for per-day KPIs like Kiln Output (target ≥2,000
MT/day) the monthly figure is the **average of the days**, not the month's
total — because that is what compares against a per-day target.

---

## 6. Spotting exceptions

What to look at, in order of how much it matters:

| Priority | Look for | Why |
|---|---|---|
| 1 | A figure that disagrees with what your department believes it filed | A trust event. Report it immediately |
| 2 | KPIs reading "no data" | A reporting gap, not a performance result |
| 3 | A sudden step change in a trend | Usually a data-entry error, occasionally real |
| 4 | Correction requests piling up | Either the forms are unclear or figures are being filed too hastily |
| 5 | A KPI persistently off target | The actual business question — but only reliable once 1–4 are clean |

**Order matters.** Do not investigate a performance trend until you are
satisfied the data underneath it is complete. This is the single most
common way plant MIS reporting misleads people.

---

## 7. Exporting for meetings

**MIS Reports & Exports** produces Excel files from the same figures shown
on screen. Choose the period and export.

**Before a management meeting:**

- Export well ahead of the meeting, not during it
- Spot-check two or three figures against the source reports
- Note which KPIs are "no data" so you can say why, rather than being asked
- Check whether any figure you plan to quote is marked provisional

---

## 8. What you cannot do, and why

| You cannot | Why |
|---|---|
| Approve your own submission (if you are L2/L3) | Separation of duties |
| Approve another department's reports | You do not own those figures |
| Edit another department's monthly KPIs | Each head owns their own |
| *(Management/MD)* Edit any department's KPIs | Management reads everything and edits nothing. Before 2026-09-03 this was possible, and it undermined the entire approval chain |
| Change an approved report directly | Use a correction request, so the change is attributed |
| Reopen a locked KPI month | Administrator or MD only, with a recorded reason |

These are not obstacles to work around. They are the reason the figures can
be trusted.

---

## 9. When a number is disputed

This is the most important process in this guide.

1. **Do not correct it quietly, and do not work around it.** A parallel
   spreadsheet with "the real figures" is how an MIS dies.
2. Identify the exact report type and **date**.
3. Check the status — is it draft, pending, approved?
4. Check what the source report actually says.
5. If the report and the dashboard disagree, **report it as a defect
   immediately**. That is a serious problem.
6. If the report itself is wrong, use the **correction request** process.

The system keeps a permanent record of what every report said before any
change, so "what did this report say last Tuesday" always has an answer.

---

## 10. The short version

- **Approvals** is your queue. Empty it — pending reports are not counted
- Watch for reports stuck as **Draft**. Those figures count for nothing
- **"No data" ≠ 0.** A blank KPI means nobody filed it
- **"Provisional"** means read the caveat before you quote it
- Monthly ratios are weighted properly — you can compare them to targets
- Check data completeness *before* drawing conclusions from a trend
- A disputed number gets reported, never worked around
