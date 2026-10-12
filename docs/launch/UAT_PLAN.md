# User Acceptance Test Plan — Nyati Cement MIS

**Version:** 1.0 · **Date:** 2026-09-30

Every case below is written against **behaviour verified to exist in this
codebase**, not against a generic checklist. Where a case tests something
the system does in an unusual or non-obvious way, the expected result says
so explicitly, because that is exactly where a tester would otherwise
record a false failure.

---

## How to use this plan

- Test **as a real user account of the role named**, never as `admin`.
  Testing everything as an administrator proves nothing about permissions.
- Use a **real reporting date** the department would actually file.
- Record **Actual result** verbatim, including the exact error text.
- A case is **PASS** only if the expected result occurs *for the stated
  reason*. Right outcome by luck is a FAIL with a note.

| Field | Meaning |
|---|---|
| Status | PASS / FAIL / BLOCKED / NOT RUN |
| Tester | Real name of the person who ran it |
| Date | Date executed |

---

## A. Authentication

| ID | Description | Preconditions | Steps | Expected result | Status | Tester | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| A-01 | Valid login | Active account, password known | Open `/login.html`, enter credentials, submit | Lands on the role's home page; session established | | | | |
| A-02 | Wrong password | Active account | Enter a deliberately wrong password | Rejected with a generic message. **Must not reveal whether the username exists** | | | | |
| A-03 | Unknown username | — | Log in with a nonexistent user | Same generic rejection as A-02 — indistinguishable | | | | |
| A-04 | Account lockout | Active account | Enter a wrong password repeatedly past the configured limit | Account locks out; further attempts refused even with the correct password until the lockout window expires | | | | |
| A-05 | Rate limiting | — | Submit many rapid login attempts from one device | "Too many attempts from this device. Wait a few minutes and try again." | | | | |
| A-06 | Forced password change | Account flagged `must_change_password` | Log in | Cannot reach any page except the password change screen; API returns `PASSWORD_CHANGE_REQUIRED` | | | | |
| A-07 | Logout revokes the session | Logged in | Log out, then replay the old token (browser back / stale tab) | Old session refused — **token revocation is server-side, not just a cleared browser store** | | | | |
| A-08 | Password change revokes other sessions | Logged in on two devices | Change password on device 1 | Device 2's session is refused on its next request | | | | |
| A-09 | Deactivated account | Admin deactivates a logged-in user | User makes any request | Refused immediately — not at token expiry | | | | |
| A-10 | Long shift, no surprise logout | Logged in > 6 h, still working | Keep using the app past the 6-hour mark | Session silently renews; user is **not** logged out mid-entry | | | | |
| A-11 | Unauthorized direct URL | Logged in as an L3 officer | Type `/monitor.html` in the address bar | Redirected away; the underlying API also refuses | | | | |
| A-12 | Forgot password, unknown address | — | Request a reset for an address with no account | Returns success. **Must NOT reveal that the address is unknown** (verified live: returns 200) | | | | |
| A-13 | Forgot password, real address | Account with an email | Request a reset | Same response as A-12. *Note: email delivery is currently blocked at the tenant (RAID R-6) — expect no message until IT enables SMTP* | | | | |

---

## B. Daily reporting

Run section B **once per reporting department**, using that department's own
form. The critical cases are B-04, B-07 and B-08.

| ID | Description | Preconditions | Steps | Expected result | Status | Tester | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| B-01 | Open your own form | L3 officer | Open your department's daily form | Form loads; date defaults sensibly | | | | |
| B-02 | Open another department's form | L3 officer | Attempt to open a form you do not own | Refused — server-side, not just hidden in the menu | | | | |
| B-03 | Save a draft | L3 officer | Enter partial figures, Save Draft | Saved and confirmed | | | | |
| B-04 | **A draft is NOT reported data** | Draft saved (B-03) | Open the KPI dashboard for that month | The drafted figures **do not** appear. This is correct and intended — a draft is not a submission | | | | |
| B-05 | **Reopen a draft, nothing lost** | Draft saved with *every* field filled, including free-text and table rows | Leave the page, return to the same date | Every value returns, including the pile log, dispatch rows and sign-off names (this was a real past defect — RAID I-22/I-23) | | | | |
| B-06 | Validation rejects bad input | — | Enter a negative tonnage / text in a numeric field | Rejected with a message naming the field | | | | |
| B-07 | Submit as L3 → goes for approval | L3 officer | Complete and Submit | Status becomes **`pending_approval`**, not approved. Figures do **not** yet reach the KPIs | | | | |
| B-08 | Submit as L1 HOD → self-certifying | L1 HOD | Complete and Submit | Status becomes **`approved`** immediately (an HOD signs their own) and figures reach the KPIs | | | | |
| B-09 | Duplicate submission | Day already submitted | Submit the same form and date again | Refused with **`409 REPORT_LOCKED`** — it does **not** silently overwrite | | | | |
| B-10 | Approved report cannot be quietly edited | Approved day | Open that date and try to save | Refused `409 REPORT_LOCKED`; the form explains how to request a correction | | | | |
| B-11 | Submission status is visible | Reports in several states | Look at the reports list | Draft / pending / approved / rejected are each clearly distinguishable | | | | |
| B-12 | Missing report is identifiable | A day deliberately not filed | Check the completeness view | That day shows as missing, not as zero | | | | |

---

## C. Approval workflow

| ID | Description | Preconditions | Steps | Expected result | Status | Tester | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| C-01 | Approval queue shows only your own | L1 HOD | Open approvals | Only your department's form types appear — never another department's | | | | |
| C-02 | Approve a report | Pending report exists | Approve it | Status `approved`; figures now appear in the KPIs | | | | |
| C-03 | Reject a report | Pending report exists | Reject with a reason | Status `rejected`; figures do **not** enter the KPIs; submitter can see why | | | | |
| C-04 | **Cannot approve your own submission** | L2/L3 submitted | Same person tries to approve | Refused — separation of duties is enforced server-side | | | | |
| C-05 | Cannot approve another department's | L1 HOD of dept A | Attempt to approve dept B's report | Refused with 403 | | | | |
| C-06 | Power-cons approver is E&I | `pm` submitted a power-cons report | E&I HOD opens approvals | It appears for **E&I**, not P&M (decision DEC-003) | | | | |
| C-07 | Dispatch approver is Logistics | Packing submitted a dispatch report | Logistics HOD opens approvals | It appears for **Logistics** (DEC-004) | | | | |
| C-08 | Quality approver is Production | Quality/lab submitted | Production HOD opens approvals | It appears for **Production** (DEC-005) | | | | |

---

## D. Correction requests

This workflow exists so that a locked report can be fixed **without a
developer**. If any case here fails, the launch loses its only safe
correction path.

| ID | Description | Preconditions | Steps | Expected result | Status | Tester | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| D-01 | Request a correction | Approved report | Click "Request a correction", give a reason | Request recorded; HOD sees it in a second queue | | | | |
| D-02 | Grant a correction | Request pending | HOD grants it | A **time-boxed** window opens; the form becomes writable | | | | |
| D-03 | **Granting does not remove the day from reporting** | Correction granted | Check the KPI dashboard while the window is open | The day's figures are **still** in the KPIs — a correction in progress must not blank a management number | | | | |
| D-04 | Edit within the window | Window open | Change a figure and save | Saved; previous figures preserved in the revision log | | | | |
| D-05 | Window expires unused | Granted, then wait | Let the window close without editing | Grant-time figures restored; report locked again | | | | |
| D-06 | Decline a request | Request pending | HOD declines with a reason | Requester is told the outcome; report stays locked | | | | |
| D-07 | Withdraw a request | Own request pending | Requester withdraws | Request closed; no window opens | | | | |
| D-08 | Prior figures are recoverable | A report corrected via D-04 | Ask what the report said before | The earlier values are retrievable from the revision log | | | | |

---

## E. Monthly KPI submission

| ID | Description | Preconditions | Steps | Expected result | Status | Tester | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| E-01 | Edit your own department's KPIs | L1 HOD | Enter monthly target/actual values | Saved | | | | |
| E-02 | Cannot edit another department's | L1 HOD | Attempt another department's KPIs | Refused 403 | | | | |
| E-03 | **L2/L3 cannot edit monthly KPIs** | L2 or L3 user | Attempt to edit | Refused — monthly KPIs are L1-only | | | | |
| E-04 | **Management cannot edit KPIs** | `management` user | Attempt to edit any department's KPIs | Refused. Management reads everything and edits nothing | | | | |
| E-05 | Submit the month | L1 HOD, month populated | Submit | Month locks | | | | |
| E-06 | Submitting an empty month | L1 HOD, month empty | Submit | Refused | | | | |
| E-07 | Writes after lock | Month submitted | Attempt to change a value | Refused **`409 KPI_PERIOD_LOCKED`** | | | | |
| E-08 | Admin is not exempt from the lock | Month submitted | Admin attempts a direct write | Refused — admin must reopen first, so the reason is on record | | | | |
| E-09 | Reopen requires a reason | Month locked | Admin/MD reopens with a 3-character reason | Refused — reason must be ≥10 characters | | | | |
| E-10 | Reopen is recorded | Month locked | Admin/MD reopens with a proper reason | Reopened; original submitter and the reopener are both retained in the record | | | | |

---

## F. Analytics, KPIs and MIS

The most important cases in the entire plan are **F-05 and F-06**: a
management number that disagrees with the report it came from is the one
defect that destroys the system's credibility.

| ID | Description | Preconditions | Steps | Expected result | Status | Tester | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| F-01 | Daily figure appears | Report approved today | Open analytics for that date | The figure filed is the figure shown | | | | |
| F-02 | Trend chart matches the KPI card | A month with data | Compare a KPI card against its own trend chart | They agree (they are two views of the same rows by construction) | | | | |
| F-03 | **Monthly ratio is weighted, not averaged** | A month with varying daily production | Check Specific Power Consumption | Equals *total energy ÷ total production* for the month — **not** the mean of the daily ratios | | | | |
| F-04 | Per-day KPI vs per-day target | A month of kiln output | Check Kiln Output monthly | Shown as the **mean of the days**, compared against the ≥2,000 MT/**day** target — not a monthly sum | | | | |
| F-05 | **MIS dashboard matches source** | Approved reports for a month | Pick 3 figures on the MIS pack and trace each to the report it came from | All 3 match exactly | | | | |
| F-06 | **Export matches the screen** | Same month | Export, open in Excel | Totals identical to the on-screen figures | | | | |
| F-07 | **"No data" is not shown as zero** | A month with a stream missing | Open that KPI | Reads "no data" / blank — **never 0**. A zero on an efficiency KPI reads as perfection and would be a serious defect | | | | |
| F-08 | Provisional KPIs are flagged | Open Specific Power Consumption | — | Marked provisional, with a readable note explaining the caveat before the number is quoted | | | | |
| F-09 | Date range filter | Analytics open | Change the date range | Data updates correctly; no stale figures | | | | |
| F-10 | Department filter | MIS open as management | Filter by department | Only that department's data | | | | |
| F-11 | Empty state | Pick a month with no data at all | — | A clear empty state — not zeros, not an error, not a blank screen | | | | |
| F-12 | Target vs actual | A department with monthly targets | Open the KPI tracker | Target and actual both shown; variance direction correct (for some KPIs lower is better) | | | | |

---

## G. Permissions — run once per role

Run the whole row as that role. **Any ✅ that is actually refused, or any ❌
that is actually permitted, is a launch blocker.**

| Role | View own dept | View other dept | Submit daily | Approve own dept | Edit monthly KPI | MIS dashboard | System Monitor | Admin users |
|---|---|---|---|---|---|---|---|---|
| L3 officer | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| L2 senior | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| L1 HOD | ✅ | ❌ | ✅ | ✅ | ✅ own only | ❌ | ❌ | ❌ |
| `management` | ✅ all | ✅ | ❌ | ❌ | **❌** | ✅ | ❌ | ❌ |
| `md` | ✅ all | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| `quality` | ✅ | ✅ Production KPI **view only** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `stores` | ✅ | ✅ Purchases **read-only** | ✅ | ✅ materials | ✅ stores | ❌ | ❌ | ❌ |
| `sales` | ✅ | ❌ **not Purchases** | ✅ | ✅ sales-projection | ❌ | ❌ | ❌ | ❌ |
| `it` | — | — | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ all | ✅ | ✅ | ✅ |

| ID | Description | Expected result | Status | Tester | Date |
|---|---|---|---|---|---|
| G-01 | Every cell in the table above behaves as stated | Matrix holds exactly | | | |
| G-02 | Permissions hold against the API directly, not just the UI | Call a forbidden endpoint with a valid token for the wrong role → 403 | | | |
| G-03 | A promotion takes effect immediately | Change a user's level; their next request uses the new level without re-login | | | |

---

## H. Error handling

| ID | Description | Steps | Expected result | Status | Tester | Date |
|---|---|---|---|---|---|---|
| H-01 | Network failure mid-entry | Disconnect the network, then save | A clear message; **entered data is not lost** | | | |
| H-02 | API failure | Server unreachable | Readable message, not a raw stack trace | | | |
| H-03 | Database failure | DB stopped | App reports degraded/unhealthy rather than showing wrong numbers | | | |
| H-04 | Session expiry mid-entry | Let the session lapse, then submit | Prompted to re-authenticate; work recoverable | | | |
| H-05 | Invalid data | Submit malformed values via the form | Rejected with field-level messages | | | |
| H-06 | Odoo integration failure | Odoo unreachable | Dashboards show stale-with-timestamp or "no data" — **never a fabricated figure**; `/api/health` reports the sync as not ok | | | |
| H-07 | Two users, same report, same time | Both open and submit the same day | Second is refused or merged predictably — no silent overwrite, and the revision log shows what happened | | | |

---

## I. Reports, search and export

| ID | Description | Expected result | Status | Tester | Date |
|---|---|---|---|---|---|
| I-01 | Search a report by date | Correct report returned | | | |
| I-02 | Filter by department / form type | Correct subset | | | |
| I-03 | Filter by status | Only that status | | | |
| I-04 | Export a date range | File downloads and opens | | | |
| I-05 | Export totals are correct | Totals match the source reports | | | |
| I-06 | Export formatting | Dates, units and decimals readable in Excel | | | |
| I-07 | Plant Memo Search | Returns relevant results; nothing outside the user's permitted scope | | | |
| I-08 | Large range performance | Completes in reasonable time without hanging the browser | | | |

*Note on I-08: `GET /api/quarry/tickets` currently returns the entire
ticket history — measured at **12.67 MB / 49,559 rows** on 2026-09-30. Test
this case explicitly on the Quarry report and expect it to be slow until
RAID I-19 is fixed.*

---

## J. Sign-off

UAT is complete only when every section has been executed by a real user of
the relevant role — not by the developer on their behalf.

| Section | Role required | Tester name | Date | Result | Signature |
|---|---|---|---|---|---|
| A — Authentication | Any user | | | | |
| B — Daily reporting | One L3 per reporting dept | | | | |
| C — Approval | One L1 HOD per dept | | | | |
| D — Corrections | L3 + L1 pair | | | | |
| E — Monthly KPI | L1 HOD | | | | |
| F — Analytics/MIS | Management | | | | |
| G — Permissions | One user per role | | | | |
| H — Error handling | Developer + one user | | | | |
| I — Reports/Export | Manager | | | | |

**Launch authority sign-off:**

| | Name | Role | Date | Signature |
|---|---|---|---|---|
| Business owner | *REQUIRES CONFIRMATION* | Plant Head | | |
| Executive sponsor | *REQUIRES CONFIRMATION* | MD | | |
| Technical owner | | Developer | | |
