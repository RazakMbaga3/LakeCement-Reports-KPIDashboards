# MIS User Accounts — Audit & Email Standardization Plan

**Audited:** 2026-08-28, live against the `lcl_mis` PostgreSQL database (`users` table).
**Owner:** IT / MIS
**Status:** Plan — awaiting department returns.

---

## A. Current state — what we actually have

**48 rows in `users`. All 48 are `active = true`.**

| Class | Count | Detail |
|---|---|---|
| Human departmental accounts | **43** | Spread over 16 department labels |
| Automation service accounts | **2** | `import-production`, `import-pm` (dept `AUTOMATION`) |
| Test / scratch accounts | **3** | `uitest_verify` (**role = admin**), `ap_md`, `ap_production` |

### The 43 human accounts, by department

| Department | Accounts | HOD | Senior | Officer | Ever logged in | Still on default password |
|---|---|---|---|---|---|---|
| CORPORATE | 2 | 2 | 0 | 0 | 2 | 1 |
| E & I | 3 | 1 | 1 | 1 | 1 | 3 |
| FINANCE | 3 | 1 | 1 | 1 | **0** | 3 |
| HR & ADMIN | 3 | 1 | 1 | 1 | **0** | 3 |
| IT | 4 | 2 | 1 | 1 | 1 | 3 |
| LOGISTICS | 3 | 1 | 1 | 1 | 1 | 3 |
| MINING *(stale label)* | 1 | 1 | 0 | 0 | 1 | 0 |
| OPERATIONS | 1 | 1 | 0 | 0 | 1 | 1 |
| P & M | 3 | 1 | 1 | 1 | 1 | 2 |
| PACKING | 3 | 1 | 1 | 1 | 1 | 3 |
| POWER PLANT | 3 | 1 | 1 | 1 | 1 | 2 |
| PRODUCTION & QC | 3 | 1 | 1 | 1 | 2 | 3 |
| PURCHASE | 3 | 1 | 1 | 1 | 1 | 3 |
| QUARRY | 2 | **0** | 1 | 1 | 0 | 2 |
| SALES & MARKETING | 3 | 1 | 1 | 1 | 1 | 3 |
| STORES | 3 | 1 | 1 | 1 | 1 | 2 |
| **Total** | **43** | 16 | 13 | 14 | **15** | **37** |

---

## B. Findings that block "verify users by email"

1. **There is no email field.** The `users` table has 14 columns — `id, username, password_hash, full_name, role, department, active, created_at, last_login, failed_attempts, locked_until, must_change_password, token_version, level`. None of them is an email address. Nothing today can be verified by email, no password can be reset by email, and no account can be traced to a named person.

2. **Accounts are department *slots*, not people.** `production_senior` is a job slot, not a human being. The audit log therefore records the slot, not the person who acted. Standardizing on email forces the 1-person-per-account decision we have so far avoided.

3. **37 of 43 human accounts are still on the default password**, and those defaults are committed in plain text in `backend/db/seed.js` in the Git repository. Anyone with repo access can log in as any of those 37 accounts.

4. **28 of 43 accounts have never logged in.** Finance (0/3), HR & Admin (0/3) and the Quarry officer/senior pair (0/2) have never been used at all.

5. **Test accounts are live in production.** `uitest_verify` carries `role = admin` with password rotation already switched off. `ap_md` and `ap_production` are approval-flow test rigs. All three must go before go-live.

6. **Department labels have drifted.** The Quarry HOD (`mining`) still sits under `department = 'MINING'` while `mining_officer` and `mining_senior` are under `'QUARRY'` — so Quarry shows as having no HOD. `LCL_Access_Matrix_2026.xlsx` is also stale: it lists 11 departments and predates Purchase, E & I, Packing and Sales becoming first-class.

7. **SMTP is not configured.** In `backend/.env`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and `DIGEST_TO` are all empty. Even once addresses are collected, the system cannot send a verification mail, a password reset, the morning KPI digest, or a watchdog alert until IT provisions a sending mailbox.

---

## C. The standard we are adopting

- **Email is the identity.** Format `firstname.lastname@lakecement.co.tz`. *(Domain assumed from `SMTP_FROM=mis@lakecement.co.tz` in `.env.example` — IT to confirm before anything is loaded.)*
- **One account = one named person.** No shared departmental logins except the two `AUTOMATION` service accounts.
- **`role` + `level` stay the access key.** Access rules across the app key off `role` (department) and `level` (`officer` / `senior` / `hod`). Those do not change. Email is added alongside as a unique identity and login alias.
- **Three levels per department**, matching the existing `level` column: L1 HOD → L2 Senior → L3 Officer.

### What each level can do (confirmed by the Plant Head, 2026-08-28 — now enforced in code)

| Capability | L1 HOD | L2 Senior | L3 Officer |
|---|:--:|:--:|:--:|
| View own department's KPI dashboard | ✅ | ✅ | ✅ |
| **Edit monthly KPI values** (`PUT /api/kpi/:dept/:year/:month`) | ✅ | ❌ | ❌ |
| Fill / edit daily reports | ✅ | ✅ | ✅ |
| Submit a daily report | ✅ *(self-certifying — lands `approved`)* | ✅ *(lands `pending_approval`)* | ✅ *(lands `pending_approval`)* |
| **Approve / reject** the department's daily reports | ✅ | ❌ | ❌ |
| Override a formula-computed KPI | admin / md only | ❌ | ❌ |

Enforced in three places, all verified by `npm run test:kpi-level`:

- [backend/middleware/kpiAccess.js](../backend/middleware/kpiAccess.js) — KPI writes need the right role **and** `level = 'hod'`. `admin` is the break-glass exemption.
- [backend/middleware/approval.js](../backend/middleware/approval.js) — approve/reject needs `level = 'hod'` **and** the role that owns the form type.
- [backend/routes/reports.js:109](../backend/routes/reports.js#L109) — `selfApproves` is HOD-only, so L2/L3 submissions queue for their HOD.

The client mirrors the KPI gate in [auth.js](../auth.js) (`_canEditKpiAtMyLevel`) so the "Fill Monthly Data" button is hidden rather than offering a save the server will refuse.

**Note on coverage:** E & I and Packing HODs can edit KPIs but own no daily form types, so they have nothing to approve. Logistics and Sales HODs are the reverse — they approve reports but have no KPI departments. Both are consequences of the existing `FORM_ACCESS` / `KPI_EDIT_DEPTS` maps, not of the level gate.
- **No personal email addresses.** Company mailbox only; a person with no mailbox gets one created before their account is issued.

---

## C2. Roster as provisioned (2026-09-03)

Domain **confirmed** as `@lakecement.co.tz`. Ten L1/HOD accounts now carry a named holder and a company mailbox, applied by [scripts/provision-hod-accounts.js](../backend/scripts/provision-hod-accounts.js). Passwords, roles, levels and active flags were **not** touched — the script gives an account a face, it never grants access.

| Account | Department | Holder | Title | Email |
|---|---|---|---|---|
| `management` | Corporate | Sankalp Jaithalia | CFO | sankalp.jaithalia@ |
| `planthead` | Operations | Pavan Gandhi | Plant Head / COO | pavan.gandhi@ |
| `sales` | Sales & Marketing | IPN Pathak | Strategic Business Head **+ Sales HOD** | indra.pathak@ |
| `purchase_hod` | Purchase | Sajiv Kumar | General Manager **+ Purchase HOD** | sajiv.kumar@ |
| `finance` | Finance | Muneesh Kumar | Finance HOD | muneesh.kumar@ |
| `ei` | E & I | Lokesh Thota | HOD | lokesh.thota@ |
| `hr` | HR & Admin | Sophia Mkassi | HOD | sophia.mkassi@ |
| `it` | IT | Saurabh Bhattacharya | HOD | saurabh.bhattacharya@ |
| `logistics` | Logistics | Pradeep Kumar | HOD | pradeep.kumar@ |
| `packing` | Packing | Jatinder Dogra | HOD | jatinder.dogra@ |
| `cpp` | Power Plant | Anbarasan Raman | HOD | anbarasan.raman@ |
| `production` | Production & QC | Godhania Natha | HOD | godhania.natha@ |
| `mining` | Quarry | Mukesh Agarwal | HOD | mukesh.agarwal@ |
| `stores` | Stores | Kishor Jadav | HOD | kishor.jadav@ |

`email_verified` is `false` on all fourteen — nobody counts as verified until they follow a link, which needs SMTP (step 4 below). The Quarry HOD's stale `department = 'MINING'` was corrected to `'QUARRY'` in the same run, so the Quarry group is finally HOD + Senior + Officer.

**Still unnamed:** `md` (Kush Patel — email not yet supplied), `pm` (P & M — no name given), and `admin` (the system account, which should stay unnamed). **All 33 L2/L3 slots** are also unnamed.

### Open issue — two people, two hats each

`role` is single-valued (one department per account) and the email index is deliberately one-account-per-person, so neither of these can hold a second login. Both are currently parked on their **department** account and therefore have only that department's access, not the group-wide oversight their title implies:

| Person | Has | Title also implies |
|---|---|---|
| Sajiv Kumar | Purchase HOD — Purchases dashboard, no KPI departments | General Manager — presumably all departments |
| IPN Pathak | Sales HOD — Sales dashboard, approves sales projections | Strategic Business Head — presumably all departments |

Three ways out, none yet chosen:

1. **Leave as is.** Simplest; both keep departmental access only. Fine if they don't personally use the dashboard for oversight.
2. **Promote the account** to `role = 'management'` (view everything + edit every department's KPIs). Costs them their department's approval rights — approvals key off the owning role, so a `management` account can no longer approve Purchase or Sales reports.
3. **Add a second role dimension** — a nullable `oversight_role` on `users`, consulted only for view rights. The correct fix, and the largest: it touches `PERMISSIONS`, the sidebar filter, and every `requireRole` call.

Also worth confirming: `management` (Sankalp Jaithalia, CFO) carries `editDepts: 'all'` — **KPI edit rights on all eight KPI departments**. That is the widest edit grant in the system. Intended for a CFO, or should the CFO be view-only?

## D. Rollout sequence

| # | Step | Owner | Depends on |
|---|---|---|---|
| 0 | Confirm mail domain + who provisions mailboxes | IT | — |
| 1 | Send collection mail to the 15 HODs, with template attached | IT / MIS | 0 |
| 2 | Migration `011_user_email.sql` — add `email` (UNIQUE), `phone`, `staff_no`, `email_verified` | MIS | — (can run in parallel) |
| 3 | Load returns; create one account per named person; **deactivate** unclaimed slots rather than delete (audit-log FKs) | MIS | 1, 2 |
| 4 | **BUILT** — invitation / reset / verification emails, `set-password.html`, `forgot-password.html`, bulk invite. Waiting only on IT to provision a mailbox and set `SMTP_HOST` + `APP_URL` | IT | 0, 3 |
| 5 | Purge `uitest_verify`, `ap_md`, `ap_production`; rotate `admin`; re-issue all 37 default passwords | MIS | 3 |
| 6 | Fix `mining` → `department = 'QUARRY'`; re-baseline the Access Matrix onto the 15 current departments | MIS | 3 |

**Deactivate, do not delete.** `users.id` is referenced by `audit_log`, `report_approvals`, `kpi_overrides`, `weighbridge_tickets`, `sales_targets` and more. Deleting a row would orphan history. Set `active = false`.

---

## E. What we are asking each department for

One row per person who needs access:

| Field | Why we need it |
|---|---|
| Full name | Becomes `users.full_name`; shown on every entry and approval |
| Company email | Becomes the login identity and the verification target |
| Mobile | Fallback contact for account recovery |
| Staff / payroll number | Ties the account to HR records |
| Job title | Sanity-check against the level assigned |
| Access level (L1 HOD / L2 Senior / L3 Officer) | Sets `users.level`; L1 is the only tier that can sign off reports |
| Department | Sets `users.department` and `users.role` |
| Needs to *enter* data, or only *view*? | Confirms which forms the account is opened for |
| Replaces which existing login? | Lets us retire the shared slot cleanly |

---

## F. Open questions for the business

1. **Domain** — is it `@lakecement.co.tz`, or something else?
2. **Do all staff have mailboxes?** Shift operators and weighbridge staff may not. If they do not, either HR/IT create them, or those roles keep a supervised shared login and we document the exception.
3. **Headcount** — do we cap at 3 accounts per department (the current shape), or open it to every person who needs entry access? This changes the total from ~45 to potentially 80+.
4. **Who approves an access request** — the HOD alone, or HOD plus IT?
