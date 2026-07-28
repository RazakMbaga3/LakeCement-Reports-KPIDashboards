# GO-LIVE CHECKLIST — Lake Cement MIS (Nyati Dashboard)

One-time cutover plan for putting the MIS into production on the plant
server and retiring the Excel-based daily reporting. Work through it top
to bottom and tick as you go; the technical steps reference
[RUNBOOK.md](RUNBOOK.md) rather than repeating it.

Status as of 2026-07-17: all build phases accepted on the dev laptop
(see [PROGRESS.md](PROGRESS.md)); everything below happens on/for the
**plant server**.

---

## 1. Decisions & inputs to collect first

Nothing else can finish until these exist. Owners fill them in here:

- [ ] **Server hostname/IP** the plant will use → becomes `ALLOWED_ORIGIN`
      and the URL users get. _____________________
- [ ] **SMTP account** for digest + alerts (host, port, user, password,
      from-address) — without it, email features stay silently off.
- [ ] **Recipient lists**: `DIGEST_TO` (morning KPI digest) and `ALERT_TO`
      (watchdog alerts — should include IT, not only management).
- [ ] **Backup destination** (`BACKUP_DIR`) on a **different physical disk
      or a network share** — a backup on the database disk is not a backup.
- [ ] **Final user list** with role per person, from the access matrix
      (`LCL_Access_Matrix_2026.xlsx`) — one account per person, no shared
      logins, so the audit trail means something.
- [ ] **Parallel-run window agreed** (recommend 2–4 weeks, §5) and a named
      owner per daily form who is accountable for entry by the cutoff
      (`MISSED_ENTRY_CUTOFF`, default 10:00).
- [ ] **Sign-off authority named** (MD or Plant Head) for the cutover
      decision in §6.

## 2. Install on the plant server

Follow RUNBOOK §9 (first-time server setup) end to end:

- [ ] Node 22+, Nginx installed; repo cloned to `C:\apps\LakeCementDashboard`.
- [ ] `backend/.env` filled from `.env.example` — DB credentials, generated
      `JWT_SECRET`, real `ALLOWED_ORIGIN` (not `*`), `TRUST_PROXY=1`,
      `BACKUP_DIR`, `PG_BIN`, SMTP + recipients from §1.
- [ ] Database created; `schema.sql` + `npm run migrate` + `npm run seed` run.
- [ ] Nginx configured from `deploy/nginx.conf`; site opens and login works.
- [ ] Windows service installed (`npm run service:install`, admin shell).

## 3. Security hardening (do not go live without these)

- [ ] **Change the Odoo Postgres superuser password** — `openpg` ships with
      the well-known default `openpgpwd`; anyone on the LAN who can reach
      port 5432 owns every database until this is done (RUNBOOK §6, found
      2026-07-06). Update Odoo's `odoo.conf` to match and restart Odoo.
- [ ] Fresh `JWT_SECRET` generated on the server (never reuse the dev one).
- [ ] Strong, unique `lcl_admin` DB password set in psql and `.env`.
- [ ] `ALLOWED_ORIGIN` is the real origin — boot log shows **no** CORS
      warning.
- [ ] All real user accounts created; **every seeded/default password is
      dead**: each user has logged in once and been forced through the
      password change (`must_change_password`). Disable accounts of anyone
      on the seed list who shouldn't exist in production.
- [ ] `backend/.env` is not in git (`git status` clean of it) and is
      readable only by the service account.
- [ ] `METRICS_TOKEN` set if a Prometheus scraper will be pointed at
      `/api/metrics`; otherwise leave empty (JWT-only access).

## 4. Verification on the server

- [ ] `npm test` green (lint + smoke).
- [ ] `npm run backup` writes a dump into `BACKUP_DIR`; then
      `npm run restore:drill` green — proves backups are restorable.
- [ ] **Reboot test**: restart the server; site and `/api/health`
      (`"status":"ok"`) come back with **no manual step**.
- [ ] Digest pipeline: send a manual digest (admin button on
      `reports-export.html` or `POST /api/mis/digest/send`) and confirm it
      arrives in the `DIGEST_TO` inboxes.
- [ ] Watchdog: `npm run watchdog` runs clean; alert email arrives at
      `ALERT_TO` when a check is deliberately failed (e.g. temporarily set
      `BACKUP_MAX_AGE_HOURS=0`, run, then revert).
- [ ] One real test entry per form type submitted by a user with that role,
      visible on the dashboard and in the daily MIS report; then corrected/
      noted so the parallel run starts clean.
- [ ] `monitor.html` shows green health chips and the test activity.

## 5. Parallel run (recommend 2–4 weeks)

Excel and MIS both run daily. The MIS is proven against the reports the
plant already trusts before anything is switched off.

- [ ] Every department enters the day's data in the MIS **and** the usual
      Excel sheets, every day of the window.
- [ ] A named checker compares the MIS daily report KPI summary against the
      Excel figures **each day** and logs discrepancies (date, KPI, both
      values, cause once found).
- [ ] Discrepancies are resolved as either (a) an MIS bug — fix it, or
      (b) an Excel error — note it; both happen in practice.
- [ ] Known, accepted differences are documented — currently:
      *Specific Power Consumption – Up to Clinker* is a documented
      simplification until crusher/raw-mill/coal-mill tonnages are captured
      (see [KPI_REFERENCE.md](KPI_REFERENCE.md)).
- [ ] Missed-entry alerts observed working in anger (someone will forget —
      that's the feature proving itself, not a failure).

**Sign-off criteria** (all must hold over the final week):
- [ ] No unexplained KPI discrepancy vs Excel.
- [ ] All forms entered by cutoff on ≥ 90% of days without chasing.
- [ ] Digest delivered daily; no unresolved health/backup alerts.
- [ ] Nightly backups landing in `BACKUP_DIR` every day.

## 6. Cutover

- [ ] Sign-off recorded (who/date): _____________________
- [ ] Announcement to all users: MIS is now the system of record; Excel
      daily sheets stop.
- [ ] Excel daily workbooks moved to a read-only archive folder (they stay
      as history; the templates in `reportsscreensdevelopment MIS/` remain
      reference material).
- [ ] First monthly MIS report generated and distributed from the system.
- [ ] Monthly restore-drill reminder scheduled (RUNBOOK §4: run it monthly).

## 7. Rollback

If the MIS fails **during the parallel run**, nothing is lost — Excel is
still running; fix and continue the window.

If a serious problem appears **after cutover**:
1. Keep entering data on paper/Excel for the affected day(s).
2. Service/DB recovery per RUNBOOK §2–§4 (service restart, logs, restore).
3. Back-enter the missed day(s) once healthy — forms accept past dates.
4. Only if the system is down for days: formally revert to Excel and
   schedule a post-mortem before attempting go-live again.

## 8. First week after cutover

- [ ] Daily: glance at `monitor.html` (health, alerts, browser errors).
- [ ] Confirm a new dump appears in `BACKUP_DIR` every morning.
- [ ] Confirm the 06:00 digest arrives daily and figures look sane.
- [ ] Ask each department for friction points; log them as issues rather
      than letting workarounds take root.
- [ ] Review `audit_log` / override trail once — overrides should be rare
      and always carry a real reason.
