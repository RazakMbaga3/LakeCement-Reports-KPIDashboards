# Compliance Master

The register of every statutory obligation Lake Cement holds: licences,
certificates, calibrations, tax filings and payments, and the conditions of
the mining leases. It replaces `1. Compliance Master.xlsx`. Page:
`compliance.html` (sidebar → Reports & Tools → Compliance Master).

## The one rule: status is computed, never typed

On 12 Oct 2026, 96 of the workbook's 106 dated rows were past their "To" date,
and 66 of those still said "Active". So here a record's status is worked out
from its dates every time it is read (`backend/services/complianceStatus.js`).
Nobody types a status. Each record is in exactly one of these:

| Status | Meaning |
|---|---|
| **Active** | In date, or nothing is due inside the first reminder window |
| **Due** | The deadline is inside the first reminder window (default 45 days for a licence) |
| **Overdue** | The deadline has passed (from the day after it), or a condition was reviewed "Not complied" |
| **No date set** | The record has no deadline. This is a gap in the data, not a verdict |
| **Inactive** | Switched off on purpose, with a reason (for example a lapsed foreign trademark) |

Flags never change the status. A licence whose renewal has been applied for is
still Overdue until the new certificate is uploaded. It reads "Overdue ·
Renewal in progress".

## Three kinds of obligation

- **Licence / certificate** (validity). Valid From → Valid To. **Uploading the
  renewed certificate is the renewal.** Its dates become the record's dates, and
  the previous certificate stays as an older version.
- **Filing / payment** (recurring). For example VAT by the 20th of every month,
  or City Service Levy by the 7th of Jan/Apr/Jul/Oct. Each instance is listed
  under *Filings* and is marked done with its receipt. A missed instance stays
  open, so the record stays Overdue until it is filed or waived.
- **Standing condition** (condition). These are the mining-lease obligations,
  for example keeping 200 m from public buildings. They are reviewed
  periodically, and each review is recorded as Complied / Partially complied /
  Not complied.

## Who can do what

Each department owns its own records. Nobody else sees them, except
md / management / admin, who read everything. See `docs/ACCESS_MODEL.md` for
the matrix.

| | Officer | Senior | HOD | MD / management | Admin |
|---|---|---|---|---|---|
| See own department's records | ✓ | ✓ | ✓ | all departments | all departments |
| Upload a certificate, record a filing or review, flag a renewal | ✓ | ✓ | ✓ | – | ✓ |
| Add, edit and verify records; fill in a missing email | – | ✓ | ✓ | – | edit only, **never verify** |
| Deactivate, archive, move to another department | – | – | ✓ | – | ✓ |
| Reminder settings and the central Head list | – | – | – | MD only | ✓ |
| Import the workbook, run the reminder job by hand | – | – | – | – | ✓ |

**Verify** means "this record is correct as shown". The department that owns
the record attests that, and admin (IT) never does.

## Reminders

The people named on a record are reminded at its own reminder days. The
defaults are 45 / 30 / 20 days before a licence expires, and 7 / 5 / 2 days
before a monthly filing.

| When | Who |
|---|---|
| First reminder day | Responsible person (the workbook's "Level 1") |
| Second reminder day | + Supervisor ("Level 2") |
| Third reminder day | + the **central Head list** (one list for every department, kept by the MD) |
| Day after the deadline, then weekly | all three (fortnightly once a renewal is in progress) |

- **One email per person per run.** Someone named on 24 calibrations gets one
  email that lists them, not 24.
- A single item uses the subject line `Compliance Renewal Reminder: <name>`.
  The email shows the name, department, expiry date and status, has a
  **RENEW NOW** button that opens the record, and is signed "Compliance Master
  System".
- **Exactly once.** Each (record, deadline, stage, person) is sent once,
  however often the job runs. It runs at 07:00 and 14:00 Dar es Salaam time.
- **Held, not lost.** Some reminders cannot go out yet. They are recorded with
  the reason and go out on the first run after the reason clears:
  - the record is not yet verified;
  - the person has no email address;
  - reminders are switched off.
- Email goes through Microsoft Graph, using the same mail route as the
  account emails (`backend/services/mailer.js`).
- **The master switch starts OFF.** The MD turns reminders on under
  *Settings & people*, and the *Preview the next run* button first shows who
  would be emailed.

## Going live: the steps, in order

1. **Import.** Admin → *Import* tab → upload `1. Compliance Master.xlsx` →
   review the preview → *Import*.
   - The preview shows every row's "Sheet said" next to "Computed now", and
     which department owns each workbook section. Ownership can be changed per
     section, for example moving the PRODUCTION calibrations to Quality.
   - It also proves every non-blank row is accounted for.
   - Re-importing later never overwrites a record a department has edited or
     verified, and never deletes anything.
   - Keep the workbook **out of the repository**. The web root is the git
     checkout (RAID I-42).
2. **Emails.** *Settings & people* lists everyone named on a record. Fill in
   each person's address; about 19 people are missing one.
3. **Head list.** The MD chooses the central Head list in *Settings & people*.
4. **Verify.** Each department opens *Register → Show only: Not yet verified*,
   checks each record against the "Sheet said" tab, corrects dates, uploads
   the current certificate, and presses **Verify**. Several records can be
   verified at once.
5. **Switch on.** The MD presses *Preview the next run*, then switches
   **Send reminder emails** on.

## What the import does with the workbook's quirks

- **Years typed into date cells.** The EWURA lubricants licence shows
  "11 Jul 1905". That is really the year 2019 typed into a date cell. The day
  and month are unknown, so the field is left blank with a note, never guessed.
- **Shifted rows.** Rows 171–172 (TRA TIN / VRN) are shifted one column right,
  and are realigned.
- **Recurring rules in the "To" column.** Text such as "20th every month" or
  "07th Every Quarter" becomes a recurrence. "30th Every Quarter" (advance tax)
  is read as Mar/Jun/Sep/Dec; confirm with Finance.
- **Swapped day and month.** Some Mining "Due Next" dates were typed with day
  and month swapped. They are corrected only where the frequency text proves
  it. For example "Monthly (before 4th)" holding 12 Apr means 4 Dec.
- **Mining "Not complied".** A mining "Not complied" opens a real overdue
  instance or review. "Complied" closes it.
- **Spellings of the same person.** "PSS Sajiv" and "Sajivkumar PS" become one
  person; "Muneesh/ Rahul" becomes two.
- **Certificate numbers.** These are filled in from the old MIS register
  (`backend/data/mis/compliance-certs.json`) where a match is unique. Delete
  that file once the production import is done.

## Also

- **Documents** are stored in Postgres, not on disk. The nightly backup and
  the monthly restore drill therefore cover them, and the drill re-hashes the
  newest one. Uploads can be PDF, JPG, PNG, DOCX or XLSX, up to 10 MB. The type
  is checked against the file's contents, and every version is kept. A mistaken
  upload is *retracted*, never deleted.
- **Excel export** gives the register with live statuses, for auditors.
- **MIS Dashboard → Compliances** shows licences and the mining leases live
  from here.
- **KPI hint.** The monthly "Compliance to Legal Requirements" KPI (Quarry,
  Packing, Power Plant, Stores) shows the Compliance Master's figure beside the
  row as a hint. The HOD still enters the value. There is no hint when a
  department tracks no obligations.
- **Health.** `GET /api/health` → `checks.compliance` reports whether the job
  is running. Admins see each run's duration and heap in *Settings & people*.

## Code map

| Piece | File |
|---|---|
| Schema | `backend/db/migrations/037_compliance_register.sql`, `038_compliance_documents_reminders.sql` |
| Status engine | `backend/services/complianceStatus.js` |
| Loading, summary, snapshots | `backend/services/complianceData.js` |
| Workbook import | `backend/services/complianceImport.js` |
| Reminders and email | `backend/services/complianceReminders.js`, `complianceMail.js`, `mailLayout.js` |
| Access and ownership | `backend/config/complianceAccess.js`, `complianceDepartments.js` |
| API | `backend/routes/compliance.js` (`/api/compliance`) |
| Page | `compliance.html` |
| Tests | `backend/test/compliance-*.test.js`, `npm run accept:compliance`, `e2e/tests/compliance.spec.js` |
