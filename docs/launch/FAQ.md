# FAQ — Nyati Cement Reporting System

**Version:** 1.0 · 2026-09-30

Answers to the questions this system actually raises. This will grow with
real questions from the pilot — questions invented in advance are rarely the
ones people ask.

---

## Getting in

**Where is the system?**
**https://smr.lakecement.co.tz** from any computer on the plant network.

**I have no username.**
Your administrator creates accounts. Accounts are personal, not shared — so
that who filed and who approved each figure always has an answer.

**I have forgotten my password.**
Contact your administrator. The **Forgot password** link exists, but reset
emails are not being delivered yet (a mail-server setting outside this
system), so an administrator will reset it directly for now.

**Why must I change my password on first login?**
So that nobody else knows it — including whoever set up your account.

**My account is locked.**
Too many wrong password attempts locks it for a short period. Wait a few
minutes, or ask your administrator to unlock it. This protects your account
from someone guessing at it.

**Will I be logged out mid-shift?**
No. The session renews quietly while you are working. Use **Logout** when
you finish.

---

## Entering reports

**What is the difference between Save Draft and Submit?**
The most important question here. **Save Draft** keeps your work so you can
return to it — nobody else sees it and **the figures count for nothing**.
**Submit** files the report officially and sends it for approval.

**I filled in the report. Why is it not in the KPIs?**
Almost always one of two reasons: it is still a **Draft** (never submitted),
or it is **Pending approval** (your head has not signed it off yet).

**I saved a draft last week and it is still a draft.**
Then that day has not been reported. Open it and Submit it.

**Which date do I put?**
The date the figures are **for**, not today's date. If you are entering
yesterday's shift this morning, use yesterday's date.

**Can I fill in a report for a past date?**
Yes. Set the date to the day the figures belong to.

**I made a mistake and already submitted.**
If it has not been approved, open it and fix it. If it has been approved,
use **Request a correction** — see below.

**My report was rejected.**
Your head sent it back with a reason. Read the reason, correct it, submit
again. Rejection is a normal part of the process, not a reprimand.

**Will I lose my work if the network drops?**
Your entered data should be preserved and you will see a message. If work is
ever actually lost, report it — that is a defect, not a fact of life.

---

## Corrections and locks

**Why can I not change an approved report?**
Because its figures have already gone into the plant's KPIs and management
reports. Letting them change silently would mean nobody could trust any
figure. The lock is the feature, not the fault.

**So how do I fix an approved report?**
Request a correction: open the report, choose **Request a correction**, say
what is wrong. Your head reviews it; if they agree, the report unlocks for a
limited time. Make the change within that window.

**What if the window expires before I fix it?**
The figures return to what they were and you can request again. Nothing is
damaged.

**Do I need a developer to change a figure?**
**No.** If anyone tells you that, they are wrong. Use the correction
request, so the change is recorded with a reason and the old figures are
kept.

**Can a figure be changed without anyone knowing?**
No. The system keeps an append-only record of what every report said before
any change, and who changed it.

---

## Monthly KPIs

**Who enters monthly KPIs?**
Department heads only. Officers and seniors enter daily reports.

**I submitted the month and now I cannot change it.**
Correct — submitting locks the month. Only an administrator or the MD can
reopen it, and they must record a written reason. Check before submitting.

**Why can management not edit KPIs?**
Because management reviews these numbers. If oversight could rewrite the
figures it oversees, the approval chain would mean nothing. This was
possible until September 2026 and was deliberately removed.

---

## Reading the numbers

**A KPI says "no data". Is it broken?**
No — it means the report it needs was not filed. The system deliberately
refuses to print a 0 it cannot prove, because 0 kWh per tonne would read as
perfect efficiency rather than a missing report.

**Why do so many KPIs say "no data" right now?**
Five reporting streams — power consumption, stoppages, materials, limestone
and quality — have had no submissions since 30 June 2026. That is 21 of the
32 KPIs for August and September. As departments resume filing, the figures
appear. This is a reporting gap, not a software fault.

**What does "provisional" mean on a KPI?**
There is a known limitation in how that figure is calculated, written out
next to it. **Read the note before quoting the number in a meeting.** For
example, the specific-power figures currently understate true consumption
because Compressed Air/Utilities stopped being captured in July 2026.

**Is the monthly figure just the average of the daily figures?**
It depends on the KPI, and the system picks the right method for each:

- **Ratios** (specific power, thermal energy, heat rate) are calculated from
  monthly **totals** — total energy ÷ total production. Averaging daily
  ratios gives a different and wrong answer.
- **Per-day KPIs with per-day targets** (kiln output vs ≥2,000 MT/day) are
  the **average of the days**, because that is what compares to the target.
- **Quantities** (total power, coal consumed) are **summed**.
- **Balances** like SO pendency are averaged, never summed — they are a
  stock standing open on a date, not a flow.

**The dashboard disagrees with my report.**
**Report it immediately.** Do not adjust anything and do not quietly use
your own figure. A dashboard disagreeing with its source report is the most
serious kind of problem here.

---

## Permissions

**Why can I not see another department's data?**
Each role reaches its own department's data. Cross-department access exists
only as a short list of named exceptions.

**"Access denied" — is something broken?**
Usually not. It means your role does not include that page. If you believe
your job requires it, raise it with your head.

**Why can I not approve my own report?**
Whoever reports a figure is never whoever signs it off. If you are a
department head filing your own report, it is approved as you file it — and
there is nobody else to check it, so check it yourself.

**I was promoted. Do I need a new account?**
No. An administrator changes your level and it takes effect on your next
action — you do not even need to log out.

---

## Exports and reports

**How do I get figures into Excel?**
**MIS Reports & Exports**. Choose the period and export.

**Will the export match the screen?**
It should exactly. If it does not, report it.

**The Quarry report is very slow.**
Known issue — that page currently loads far more data than it needs
(measured at 12.67 MB). It is logged and being fixed.

---

## Trust and data

**What happens to figures I enter?**
They are stored, and once approved they feed the KPIs, the analytics and the
management pack. Nothing is re-typed anywhere.

**Can someone change my figures without me knowing?**
Not silently. An approved report is locked, corrections need a request and
an approval, and the system keeps what the report said before any change.

**Is my data backed up?**
Backups run daily. Improving where they are stored, and proving a restore
works, are launch tasks — see the administrator guide. We would rather tell
you this plainly than claim more than we have demonstrated.

**Why are emails not working?**
The mail server refuses authentication for the sending account. It needs a
setting changed by Lake Cement IT and is not something this system can fix
on its own.

---

## Reporting a problem

**What should I include?**

1. Your name and department
2. The page you were on
3. The report type and **the date of the report**
4. What you expected, and what you saw
5. The exact wording of any error message

The report date matters more than people expect — it is usually what lets us
find the problem in minutes instead of hours.

**Is it worth reporting something small?**
Yes. We would much rather hear about ten things that turn out to be fine
than miss one that is not. The way a reporting system fails is not
complaints — it is silence, workarounds, and a private spreadsheet nobody
mentions.
