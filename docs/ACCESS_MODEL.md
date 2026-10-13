# MIS Access Model

**Adopted:** 2026-09-03, on the Plant Head's direction.
**Print the live matrix any time:** `cd backend && npm run access:matrix` — it exercises the real middleware, so it shows behaviour, not intent.

---

## The four rules

| Rule | What it means here |
|---|---|
| **Implicit departmental boundary** | A role reaches its own department's objects and nothing else. Cross-department access exists only as a named, listed exception. |
| **Inheritance** | Within a department, L1 ⊇ L2 ⊇ L3. An HOD can do anything their senior and officer can, plus approve and submit. |
| **Separation of duties** | Whoever reports a figure is never whoever signs it off. L2/L3 submit daily reports and their L1 approves them; L1 submits the monthly KPIs and only admin/MD can reopen them; management reads everything and edits nothing. |
| **Least privilege** | Every intersection defaults to Deny. A permission is granted by explicit exception, and one that exists only because it always has is not a reason to keep it. |

---

## Who can do what

### Monthly KPI values

| Role | L1 HOD | L2 Senior | L3 Officer |
|---|:--:|:--:|:--:|
| production, cpp, pm, mining, stores, ei, packing | **Edit own department** | — | — |
| management, md, finance, hr, logistics, it, sales, purchase, quality | — | — | — |
| admin *(break-glass system account)* | Edit all | Edit all | Edit all |

Two gates, both required: `role` decides **which** department (`KPI_EDIT_DEPTS`), `level` decides **who** within it. See [backend/middleware/kpiAccess.js](../backend/middleware/kpiAccess.js).

**`management` was `editDepts: 'all'` until 2026-09-03.** A CFO or GM could overwrite any HOD's submitted numbers — exactly the accountability the approval chain exists to create. It is now `[]`.

### The monthly submission lock

An HOD fills a department-month, then **submits** it. From that moment `kpi_monthly` writes for that period are refused with `409 KPI_PERIOD_LOCKED`. Reopening is admin/MD only and requires a reason of at least 10 characters, recorded in `audit_log`.

- `POST /api/kpi/:dept/:year/:month/submit` — the owning L1 (refuses an empty month)
- `POST /api/kpi/:dept/:year/:month/reopen` — admin/MD, reason mandatory
- `GET  /api/kpi/:dept/:year/:month/submission` — current state, `{ status: 'open' }` when never submitted

`admin` is **not** exempt from the lock. Its break-glass exemption covers *which department*, not *bypassing a submission* — repairing a closed month goes through reopen so the reason is on record. Reopening keeps the original `submitted_by`/`submitted_at` beside who reopened it, so a month that was closed, reopened and closed again reads as exactly that. See [013_kpi_submissions.sql](../backend/db/migrations/013_kpi_submissions.sql).

### Daily reports

| | L1 HOD | L2 Senior | L3 Officer |
|---|:--:|:--:|:--:|
| Fill / edit | ✅ | ✅ | ✅ |
| Submit | ✅ self-certifying (lands `approved`) | ✅ lands `pending_approval` | ✅ lands `pending_approval` |
| Approve / reject | ✅ own department's form types only | — | — |

**Submitting and approving are separate questions.** For most form types
the answer is the same role, so `middleware/approval.js` derives the
approver from the submit map. Where two departments submit the same form
type, the approver must be named explicitly in `FORM_APPROVAL_OWNER`
(`forms/access-registry.js`) — and if it isn't, the server refuses to boot
rather than pick one silently.

| Shared form type | Who may submit | Whose HOD approves | Why |
|---|---|---|---|
| `power-cons` | `pm`, `ei` | **`ei`** | E&I owns the kWh/meter readings being signed off; P&M kept submit rights when E&I gained them (2026-09-11). Approver declared 2026-09-13 — see `docs/pm/DECISIONS.md` DEC-003 |
| `dispatch` | `logistics`, `packing` | **`logistics`** | Packing Plant fills the Dispatch & SO report (2026-09-14) — it's their core daily report. Logistics keeps submit rights and the sign-off it already had; author and approver then sit in different departments, per Separation of Duties. See `docs/pm/DECISIONS.md` DEC-004 |
| `quality`, `limestone`, `pile-quality` | `production`, `quality` | **`production`** | The lab measures every figure on these three reports, but until 2026-09-22 only Production — who receive those figures — could file them. The new `quality` role (QC Manager + lab officers) gains submit; Production keeps submit and the sign-off it already had. This is the paper trail the plant already runs: the printed sign-off strip on `forms/quality-form.html` reads Lab Analyst → QC Manager → Production Head. See `docs/pm/DECISIONS.md` DEC-005 |

The pending-approval queue (`GET /api/approvals`) is scoped on this column —
on who *approves*, not on who may submit — so an HOD is never shown a report
`requireApprover` would then 403.

### Cross-department views — the complete list of exceptions

| Surface | Who | Why |
|---|---|---|
| Sales dashboard | `sales`, `management`, `md` | Owning department + oversight |
| Purchases dashboard | `purchase`, `management`, `md`, `stores` | Owning department + oversight. `stores` added 2026-09-14: Stores receives the goods against the POs this dashboard lists, so it needs to see what is on order and when it lands — read-only; Purchase still raises every PO |
| MIS Dashboard (`mis.html`) | `management`, `md`, `admin` | Aggregates HR, assets, compliance and stores across every department |
| KPI dashboard *view* | Per `PERMISSIONS[role].kpi.depts` | Management and finance see all; departments see their own plus summary |
| Production's KPI section | `quality` (view only) | Added 2026-09-22 with the QC Manager role. The lab's readings roll up into Production's KPIs, so QC can see what its own figures become — but `KPI_EDIT_DEPTS.quality` is `[]`: the lab owns no department section of its own, and inventing one would create a KPI department with no targets, no history and nobody accountable for it |

### Compliance Master (`compliance.html`, added 2026-10-12)

Each department **owns its own statutory obligations**; there is no central
compliance role (decided with the user, DEC-009). Enforced in
`backend/config/complianceAccess.js` — the page asks `GET /api/compliance/me`
for its capabilities, so there is no browser-side copy of these rules.

| Action | Officer | Senior | HOD | md / management | admin |
|---|---|---|---|---|---|
| Read records, documents, history | own dept | own dept | own dept | **all** | **all** |
| Upload a certificate / receipt, record a filing or review, flag a renewal | ✓ | ✓ | ✓ | – | ✓ |
| Create, edit, set responsible people, verify, fill in a missing email | – | ✓ | ✓ | – | edit ✓ · **verify ✗** |
| Deactivate / archive / move to another department | – | – | ✓ | – | ✓ |
| Reminder settings, central Head list | – | – | – | **md** only | ✓ |
| Import the workbook, run / retry reminders, change an existing email | – | – | – | – | ✓ |

A record outside the caller's department answers **404**, not 403 — its
existence is not leaked. Verify is attestation by the owning department, so
admin (IT) cannot verify (Separation of Duties). md/management read every
department and write nothing — the MD holds only the reminder settings,
because the Head list is an escalation chain above departments.

Two exceptions were **removed** on 2026-09-03:

- **`sales` could view Purchases.** Purchases originally rode on Sales' gate for want of one of its own, and kept that access when it was split out. Sales has no business reason to read Purchases.
- **Twelve roles could open the MIS Dashboard.** `mis_tabs` was non-empty for hr, finance, stores, cpp, pm, it, logistics, mining and production. Worse, **the backend enforced nothing** — every route in `backend/routes/mis.js` was `requireAuth` only, so any authenticated user could read the company's HR strength, asset register and compliance certificates straight from the API. A hidden tab is not a permission.

---

## Where each rule is enforced

Enforcement is server-side; the client mirrors it so the UI does not offer actions that will fail.

| Gate | Server | Client |
|---|---|---|
| KPI department | `middleware/kpiAccess.js` `requireKpiDeptAccess` | `canFillKPIDept()` |
| KPI level (L1 only) | same, level check | `_canEditKpiAtMyLevel()` |
| KPI period lock | `middleware/kpiAccess.js` `requireKpiPeriodOpen` | `refreshKpiLockState()` in app.js |
| Daily approval | `middleware/approval.js` `requireApprover` | sidebar `canSeeApprovals` |
| Sales / Purchases | `requireRole(...COMMERCIAL_VIEW_ROLES / PURCHASE_VIEW_ROLES)` | `canViewSales()` / `canViewPurchases()` |
| MIS Dashboard | `requireRole(...MIS_VIEW_ROLES)` on the reference-data routes | `canViewMIS()`, `requireMISAccess()` page guard, sidebar group |

[forms/access-registry.js](../forms/access-registry.js) is the single source of truth. `auth.js` keeps its own literal copies because it is a plain global script on ~27 pages with no module loader, and [backend/test/access-consistency.test.js](../backend/test/access-consistency.test.js) diffs the two on every run — 8 checks, so a change to one side without the other fails loudly.

---

---

## Administering it — `admin-users.html`

Accounts are created and changed from the **Administration → User Administration** screen, not by editing `db/seed.js` and running a script. Admin-only, backed by `/api/admin/*` ([backend/routes/admin.js](../backend/routes/admin.js)).

| Action | Effect |
|---|---|
| Add user | Creates the account and shows a temporary password **once**. `must_change_password` is set, so they choose their own at first sign-in. |
| **Invite** | Emails a single-use link so they set their own password. Preferred over handing a temporary one over — nobody, IT included, ever knows it. Re-sending supersedes the earlier link. |
| **Invite unactivated…** | Bulk-invites every account in the current department filter that has never set its own password. The way out of "37 accounts on a password published in git". |
| Edit user | Name, email, phone, staff no., department, role, level, active/inactive. |
| Reset password | New temporary password, sessions revoked, lockout cleared. |
| Unlock | Clears a lockout without changing the password — for someone who mistyped five times and still knows it. |

### The email-link flows

Three purposes, all single-use and time-boxed ([backend/services/authTokens.js](../backend/services/authTokens.js), table `auth_tokens`):

| Purpose | Lifetime | Why that long |
|---|---|---|
| `invite` | 7 days | First contact with someone who may not check mail daily; a dead invite costs an admin round-trip. |
| `reset` | 1 hour | The account already works — the user is at their desk, and a longer window is only extra exposure. |
| `verify` | 14 days | Proves a mailbox reaches its owner and grants nothing else. |

**The token is never stored** — the row holds `sha256(token)`, so a read-only leak of `auth_tokens` grants nothing. A token also stops working when: it is used, it expires, the account is deactivated, the account's email is changed, or a newer token of the same purpose is issued. Following an invite or reset link sets `email_verified` — clicking it *is* proof the address reaches them.

`POST /api/auth/forgot-password` **answers identically for known and unknown addresses**. Anything else makes it an address oracle, and "which of our staff use the MIS" is exactly the list a phisher wants. The audit log records the difference; the response does not. All the unauthenticated link routes sit behind the same rate limiter as login.

Two settings gate delivery, both in `backend/.env`:

- A mail route — **Microsoft Graph** (`GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET`, sending as `SMTP_FROM`), which is what Lake Cement's tenant permits, or `SMTP_HOST` as a fallback. Without either, nothing sends.
- **`APP_URL`** — where the links point. It has **no default on purpose**: a link built against the wrong host looks like it should work and doesn't. Unset, the account emails refuse to send and say why.

When either is missing the admin screen shows a banner saying so and how many accounts are still on a password their owner never chose — an admin should not discover a broken mail config by sending 37 invitations.

Four rules the screen enforces, each a consequence of the model above:

1. **No hard delete.** `users.id` is referenced by `audit_log`, `report_approvals`, `kpi_overrides`, `kpi_submissions`, `weighbridge_tickets` and `sales_targets`. Deactivation is the only removal.
2. **No self-modification of role, level or active.** An admin cannot quietly promote themselves, and cannot lock the last working admin account out by accident. Another admin has to do it.
3. **`username` is immutable.** It is the access key every rule is written against and the anchor of every audit row already written; renaming would silently reattribute history.
4. **Access changes bump `token_version`.** A demoted user loses the old rights on their next request, not up to 8 hours later when their JWT expires.

The drawer shows **what the chosen role and level will grant** — which daily forms, whether submissions self-certify or queue for approval, whether monthly KPIs are editable, and which dashboards are visible — read live from the registry, so the screen cannot drift from the gates. `backend/config/orgCatalogue.js` supplies the role and department pickers; it is a picker, not a policy, and grants nothing.

Covered end-to-end by `e2e/tests/admin-users.spec.js` (7 tests, real browser, real Postgres).

## Known gaps

1. **`/api/mis/monthly/*` is still open to all roles.** It backs `reports-export.html`, which every role can reach. Narrowing it would break exports departments use today, so it is raised rather than changed. **Decision needed.**
2. **`admin` holds `KPI_EDIT_DEPTS: 'all'` at every level.** Intentional break-glass, but it is the one account that can write any department's KPIs without being its HOD. It is still bound by the submission lock.
3. **Two people, two hats.** Sajiv Kumar (GM + Purchase HOD) and IPN Pathak (Strategic Business Head + Sales HOD) hold only their department's access — `role` is single-valued. See [USER_ACCOUNT_STANDARDIZATION.md](USER_ACCOUNT_STANDARDIZATION.md).
4. **No per-object department tagging.** The boundary is enforced per *route and department key*, not per row. Adequate while every table is department-scoped by design; revisit if shared objects appear.
5. **The access rules themselves are still code, not data.** `admin-users.html` assigns people to roles; it cannot change what a role *means* — `FORM_ACCESS`, `KPI_EDIT_DEPTS` and the view lists still live in [forms/access-registry.js](../forms/access-registry.js). That is deliberate for now: those maps are covered by a consistency test and reviewed on change, and making them editable at runtime removes that safety net. The next step, if wanted, is moving them into tables with the same audit-and-preview treatment the user screen has.
6. **Only `admin` can administer users.** Narrower than `canManageUsers` implies it could be. When HR should raise requests, that is an approval queue on top of these routes, not a widening of them.
