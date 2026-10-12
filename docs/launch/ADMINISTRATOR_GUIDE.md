# Administrator Guide — Nyati Cement MIS

**For:** system administrators (`admin`, `md`, `it` roles)
**Version:** 1.0 · 2026-09-30

This guide covers operating the system. For architecture and code, see
[`docs/TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md). For KPI definitions, see
[`docs/KPI_REFERENCE.md`](../KPI_REFERENCE.md).

---

## 1. The administrator's first principle

**Never fix a figure by editing the database.**

The system keeps an append-only record of what every report said and who
changed it. A direct database edit bypasses that record, and the next time
someone asks why a number changed there is no answer. Use the
correction-request workflow, or reopen a KPI month with a reason — both
leave a trail.

The `admin` role is a break-glass account, not a convenience. Note that it
is deliberately **not** exempt from the monthly KPI lock: repairing a closed
month goes through *reopen*, so the reason is on record.

---

## 2. User management

**User Administration** under Administration.

### Roles and levels are two separate things

| | What it controls |
|---|---|
| **Role** | Which *department* — `production`, `cpp`, `pm`, `mining`, `stores`, `ei`, `packing`, `quality`, `logistics`, `sales`, `purchase`, `finance`, `hr`, `it`, `management`, `md`, `admin` |
| **Level** | Which *authority* within it — `hod` (L1), `senior` (L2), `officer` (L3) |

Both gates apply. A `production` + `officer` user can fill Production's
reports but cannot approve them or touch monthly KPIs. Getting the level
wrong is the most common provisioning mistake, and it either blocks someone
from working or gives them sign-off authority they should not have.

### Creating a user

1. **User Administration → add a user**
2. Set the real person's name and email — **never a shared departmental
   login**. A shared login destroys attribution: "who approved this" stops
   having an answer
3. Choose role and level
4. Issue an invite, or set a temporary password

The user must change the password on first login; this is enforced, and
until they do they can reach nothing but the password screen.

### Deactivating a user

Deactivate rather than delete. Deactivation takes effect **immediately** —
the user's next request is refused, not at token expiry. Deleting would
orphan the audit history that says what they approved.

**When someone leaves, deactivate the same day.** Their approvals stay on
record, which is correct.

### Locked-out accounts

Repeated wrong passwords lock an account for a configured window. You can
unlock it from User Administration. Before you do, confirm it is the real
user who was locked out and not someone guessing at their password.

### Printing the live permission matrix

```bash
cd backend && npm run access:matrix
```

This exercises the **real middleware**, so it shows what the system actually
does rather than what documentation claims. Use it whenever there is a
question about who can do what, and after any permission change.

---

## 3. Reopening a locked KPI month

When a head submits a month it locks. To reopen:

```
POST /api/kpi/:dept/:year/:month/reopen
```

Available to `admin` and `md` only. **A reason of at least 10 characters is
mandatory** and is written to `audit_log`. The original submitter and
timestamp are kept alongside who reopened it, so a month that was closed,
reopened and closed again reads as exactly that.

Write a reason that will still make sense in six months. "Correction" is
useless; "Coal figure restated after weighbridge reconciliation" is not.

---

## 4. System monitoring

**System Monitor** (`admin`, `md`, `it` only — enforced server-side, not
just hidden from the menu).

### The health endpoint

```bash
curl -sS https://smr.lakecement.co.tz/api/health
```

| Field | Watch for |
|---|---|
| `status` | `ok`, `degraded` or `unhealthy` |
| `checks.db.ok` | Must be `true`. If false, the system cannot record anything |
| `checks.disk.free_gb` | Alerts below the configured minimum |
| `checks.backup` | Age of the last backup, and whether it is on the app's own disk |
| `checks.odoo.sync` | Per-pull freshness — `last_success_min_ago` |

**`degraded` is not an emergency but is not "fine" either.** As at
2026-09-30 production reports `degraded` because backups sit on the same
disk as the application. Read the `warning` text to see why.

### The data pipeline view

`GET /api/monitor/pipeline`, and the first card on the System Monitor page,
distinguish two failure modes that look identical on a dashboard:

- **Not arriving** — no report was filed
- **Arriving but not counting** — reports exist but are drafts, so they are
  excluded from every KPI

The second is the more dangerous, because the data looks present in the
database while being absent from every number the plant reports. All 210
dispatch days are currently in this state.

### Watchdog alerts

A watchdog runs on a schedule and raises alerts for deep-health failures,
missed report entries, low disk and stale backups. `missed-entry:<form>`
means a report was expected and not filed.

⚠️ **Alerts currently reach nobody** — no recipients are configured, and
email delivery is blocked (see §7). Until both are fixed, check System
Monitor manually.

---

## 5. Odoo integration

Three pulls run on a schedule:

| Pull | Brings in |
|---|---|
| `dispatch-daily-summary` | Daily dispatch tonnage by grade and channel |
| `mining-weighbridge-tickets` | Weighbridge tickets (~50,000 rows as at 2026-09-30) |
| `production-report-autofill` | Production report figures, pre-filled as drafts for review |

### Checking the pulls

Read `checks.odoo.sync` in `/api/health`, or use System Monitor. Anything
older than about three hours is stale and worth investigating.

Manual test and run:

```bash
cd backend
npm run odoo:test                 # connection test
npm run odoo:dispatch-pull        # dispatch
npm run odoo:mining-pull          # mining tickets
npm run odoo:production-pull      # production autofill
```

### What the autofill does and does not do

It writes figures into the daily report as a **draft**, so a human still
reviews and submits them. That is deliberate — Odoo does not carry every
field the report needs (SO pendency, bags packed, burst bags, the vehicle
queue are manual).

**The consequence is the thing to understand:** an autofilled day that
nobody submits stays a draft and reaches no KPI. Autofill is not the same as
reported data.

### If Odoo data looks wrong

Do not "correct" Odoo's figures to match a spreadsheet. Establish which side
is wrong first. There are known open mapping gaps (MG-HG tonnage from the
North Mine, product code `QRM008`, and one 30 MT bulker discrepancy) logged
in `docs/pm/RAID_LOG.md`.

---

## 6. Backups and restore

### Current state (VERIFIED 2026-09-30)

Backups **are** running (8 hours old at audit time) but sit on the **same
disk as the application**, and **no restore has ever been demonstrated on
production**. Both are launch blockers.

### Operating them

```bash
cd backend
npm run backup            # take one now
npm run restore:drill     # exercise the restore path
```

Relevant settings: `BACKUP_DIR`, `BACKUP_CRON`, `BACKUP_KEEP_DAYS`,
`BACKUP_MAX_AGE_HOURS`.

### The rule

**A backup that has never been restored is a hypothesis.** Run a restore
drill on a schedule and write down the result — row counts restored, and
whether recent reports came back. Point `BACKUP_DIR` at a second volume or
DigitalOcean Spaces; a backup on the same disk does not survive the most
likely disaster.

---

## 7. Email — sent through Microsoft Graph

Invitations, password resets, the morning digest and watchdog alerts are
sent as `digital@lakecement.co.tz` through Microsoft Graph (Azure app "Lake
Cement Dashboard", `Mail.Send` permission). SMTP is not used: the M365
tenant blocks SMTP AUTH, and that is the safer setting to keep.

**The client secret expires.** When it does, every email stops at once and
fails with an authentication error. Ask IT for a new secret before the
expiry date, put it in `GRAPH_CLIENT_SECRET`, and restart the backend.

If the admin users page shows "Mail is not configured", the `GRAPH_*`
settings are missing from `backend/.env` on that server. Until they are
there, set passwords manually and tell users directly.

Relevant settings: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET`, `SMTP_FROM` (the sending mailbox), `APP_URL`,
`DIGEST_TO`, `ALERT_TO`.

---

## 8. Deployment

Deployment is automated and gated:

```
git push origin main
   → GitHub Actions: npm test (17 suites + smoke) + 10 acceptance suites
   → on green only: SSH to the droplet, run deploy/deploy.sh
       git reset --hard origin/main
       npm ci --omit=dev
       npm run migrate
       pm2 reload
```

**Never bypass the test gate.** It exists because a server-killing commit
once reached `main`, and the gate is what stopped it reaching production.

For rollback, see [`ROLLBACK_PLAN.md`](ROLLBACK_PLAN.md).

### After a shared JS/CSS change

nginx caches shared assets for one day. If you change a shared script or
stylesheet, **bump its `?v=` in every page that loads it**, or returning
users keep yesterday's copy.

---

## 9. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Nobody can log in | Backend down, or DB unreachable | Check `/api/health`; `pm2 status`, `pm2 logs` |
| One user cannot log in | Locked out, deactivated, or must change password | Check their account in User Administration |
| KPI shows "no data" | The underlying report was not filed, or is a draft | Check the pipeline view — "not arriving" vs "not counting" |
| Figures entered are not in the KPIs | Report is draft or pending approval | Drafts are excluded by design. Get it submitted and approved |
| Dashboard disagrees with a report | **Potentially serious** | Do not adjust anything. Capture both figures and escalate as a defect |
| "Report is locked" | Report is approved | Correct via a correction request, never by a database edit |
| KPI month will not save | Month is submitted | Reopen with a reason |
| Site up but data stale | Odoo pulls failing | Check `checks.odoo.sync`; run the pull manually |
| Quarry report very slow | Known — the ticket endpoint is unbounded (12.67 MB) | Logged as RAID I-19 |
| Emails not arriving | Tenant blocks SMTP AUTH | §7 — needs IT |

### Logs

Application logs are in `backend/logs/`, rotated daily. `pm2 logs` on the
droplet shows live output.

---

## 10. What an administrator must not do

| Never | Because |
|---|---|
| Edit figures directly in the database | Bypasses the audit trail; the change becomes unexplainable |
| Create shared departmental logins | Destroys attribution — "who approved this" stops having an answer |
| Reopen a KPI month without a real reason | The reason is the only record of why a management figure changed |
| Grant `management` KPI edit rights | Removed deliberately 2026-09-03; it let oversight overwrite the numbers it oversees |
| Give ordinary users the `it`, `admin` or `md` role to "make something work" | Those roles carry System Monitor and user administration |
| Bypass the CI test gate | It is the only thing standing between a bad commit and production |
| Restore a backup without authorisation | It discards every report filed since the backup |

---

## 11. Routine schedule

**Daily:** check `/api/health`; check Odoo sync freshness; review alerts.

**Weekly:** review missing reports by department; check backup age and
that it is off-disk; review correction requests.

**Monthly:** confirm every department submitted its KPI month; run a
restore drill and record the result; review user accounts against the real
staff list; check the RAID log for stale items.

**Quarterly:** rotate credentials; review the permission matrix against
current roles; confirm the disaster-recovery path still works.

---

## 12. Escalation

| Severity | Examples | Route |
|---|---|---|
| **P1** | System down; data loss; a permission breach; wrong figures on management dashboards | Technical owner immediately; Plant Head + MD informed |
| **P2** | A module unusable; Odoo sync failed for a day; approvals blocked | Technical owner same day |
| **P3** | A feature misbehaving with a workaround | Logged, scheduled |
| **P4** | Cosmetic | Backlog |

See [`SUPPORT_AND_INCIDENTS.md`](SUPPORT_AND_INCIDENTS.md).

**Note a continuity risk:** the system currently has a single technical
owner. Naming a second person with droplet access and deployment knowledge
is a real operational need, not a formality.
