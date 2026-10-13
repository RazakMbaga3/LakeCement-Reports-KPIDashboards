# RUNBOOK — Lake Cement MIS (Nyati Dashboard)

> **⚠ Superseded plan — kept as reference.** This describes the on-prem
> plant-LAN Windows-server deployment this repo was originally built
> around. Per the Managing Director's later direction (`TECHNICAL_SPEC.md`
> §10), production hosting moved to the cloud under the Odoo team's
> ownership, and the platform was confirmed on 2026-08-19: a **DigitalOcean
> droplet**, set up and administered by the Odoo team (India)
> (`TECHNICAL_SPEC.md` §12 item 6). The real deployment path — droplet
> build, deploy user, database, pm2, Nginx/HTTPS, push-to-deploy and
> backups — is documented in
> [`DEPLOYMENT_DIGITALOCEAN.md`](DEPLOYMENT_DIGITALOCEAN.md), which replaces
> this file for hosting purposes; current project status lives in
> [`pm/PROJECT_STATE.md`](pm/PROJECT_STATE.md). The steps below (Windows
> service, `node-windows`, PowerShell) are not the go-live path — they are
> kept unrewritten as a record of the original plan.

Operations manual for the plant server. Assumes the layout:
repo at `C:\apps\LakeCementDashboard`, backend service `LakeCementMIS`,
Nginx serving the frontend, PostgreSQL local. Everything configurable
lives in `backend/.env` (documented in `backend/.env.example`).

---

## 1. Architecture in one paragraph

Static HTML/JS frontend (repo root, served by Nginx) → `/api` reverse-proxied
to the Node/Express backend (Windows service `LakeCementMIS`, port 5000) →
PostgreSQL (`lcl_mis`). All KPI math lives in `forms/formula-registry.js`
evaluated server-side; browsers queue writes offline and sync automatically.
The backend schedules its own jobs: morning digest (06:00), watchdog alerts
(every 15 min), nightly backup (02:30).

## 2. Start / stop / status

```powershell
# Windows service (normal operation)
Get-Service LakeCementMIS
Stop-Service LakeCementMIS
Start-Service LakeCementMIS

# First-time install / removal (ADMIN shell, after .env is complete)
cd C:\apps\LakeCementDashboard\backend
npm run service:install
npm run service:uninstall

# Run in the foreground instead (debugging only)
npm run dev
```

After any reboot the service starts by itself and restarts on crash.
Quick sanity check: `http://localhost:5000/api/health` → `"status":"ok"`.

## 3. Logs

- `backend/logs/` — JSON request/error logs, one file per day, kept 14 days.
- Read the latest: any editor, or filter with e.g.
  `Select-String '"level":50' backend\logs\*.log` (level 50 = errors).
- Service wrapper logs (crashes before Node boots):
  `backend/daemon/` (created by node-windows).

## 4. Backups & restore

**Automatic:** nightly `pg_dump` at `BACKUP_CRON` into `BACKUP_DIR`
(custom format, `lcl_mis-YYYY-MM-DD-HHmm.dump`), pruned after
`BACKUP_KEEP_DAYS`. Point `BACKUP_DIR` at a **different disk or a network
share** — a backup on the database disk is not a backup.
If backups stop, `/api/health` degrades and the watchdog emails an alert
once the newest dump is older than `BACKUP_MAX_AGE_HOURS`.

```powershell
npm run backup           # manual backup right now
npm run restore:drill    # restore newest dump into a scratch DB, verify, drop
```

**Run the restore drill monthly.** It never touches the live database.

**Real restore after data loss:**
1. `Stop-Service LakeCementMIS`
2. `node scripts/restore.js <dumpfile> lcl_mis_recovered`
3. Inspect: `psql -U <user> -d lcl_mis_recovered` — check the latest
   `daily_reports` rows look right.
4. Switch over (psql, connected to the `postgres` db):
   ```sql
   ALTER DATABASE lcl_mis RENAME TO lcl_mis_broken_YYYYMMDD;
   ALTER DATABASE lcl_mis_recovered RENAME TO lcl_mis;
   ```
5. `Start-Service LakeCementMIS`, check `/api/health`, keep the broken DB
   until the cause is understood.

## 5. Users & passwords

- New user: add a row to `backend/db/seed.js` USERS and run `npm run seed`
  (re-seeding resets ALL seeded users' passwords to the defaults and forces
  a change at next login — fine at setup, disruptive later), or insert one
  user directly:
  ```powershell
  node -e "require('dotenv').config(); const b=require('bcryptjs'); const db=require('./db'); b.hash('TempPass@2026',12).then(h=>db.query(`INSERT INTO users (username,password_hash,full_name,role,department,must_change_password) VALUES ('newuser',$1,'Full Name','production','PRODUCTION & QC',true)`,[h])).then(()=>{console.log('ok');process.exit(0)})"
  ```
- Unlock a locked account:
  `UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username='...';`
- Force logout everywhere: `UPDATE users SET token_version = token_version + 1 WHERE username='...';`
- Disable an account: `UPDATE users SET active = false WHERE username='...';`

## 6. Rotating secrets

> ⚠ **Found during setup (2026-07-06):** the Odoo-bundled PostgreSQL
> superuser `openpg` still had its well-known default password
> (`openpgpwd`). Anyone on the machine/LAN who can reach port 5432 owns
> every database with it. Change it:
> `ALTER USER openpg WITH PASSWORD '<strong new password>';`
> (update Odoo's odoo.conf `db_password` to match, then restart Odoo).
> The MIS itself never uses openpg — `lcl_admin` was granted CREATEDB
> once for restore operations and that grant persists.

- **JWT_SECRET**: generate
  (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`),
  put in `.env`, restart the service. Everyone gets logged out once.
- **DB password**: `ALTER USER lcl_admin WITH PASSWORD '...'` in psql, update
  `.env`, restart the service.
- **SMTP / METRICS_TOKEN**: edit `.env`, restart the service.

## 7. Alerts — what each kind means

| Kind | Meaning | First move |
|---|---|---|
| `health-down` | Database unreachable | Check PostgreSQL service; disk; `backend/logs/` |
| `health-degraded` | Disk low or backup stale (detail says which) | Free space / check `npm run backup` output |
| `missed-entry:<form>` | No submission for that form by the cutoff | Call the department; check their network/browser (Monitor page → browser errors) |
| `watchdog-error` | The check itself failed | Read detail; check logs |

All alerts show on `monitor.html` (admin/MD/IT) and email `ALERT_TO`.
One email per kind per day.

## 8. Deploying an update

```powershell
cd C:\apps\LakeCementDashboard
git pull
cd backend
npm install            # only if package.json changed
npm run migrate        # applies any new db/migrations/*.sql
npm test               # lint + smoke — do not proceed if red
Restart-Service LakeCementMIS
```
Frontend files are picked up by Nginx immediately (they're static).

## 8a. Compliance Master — import, reminders, documents

Full guide: `docs/COMPLIANCE_MASTER.md`.

- **Import** the workbook from the page (admin → Compliance Master → Import:
  preview, then Import). Keep `1. Compliance Master.xlsx` out of the
  repository — the web root is the git checkout (RAID I-42).
- **Reminder job**: `COMPLIANCE_REMINDER_CRON` (default `0 7,14 * * *`,
  Africa/Dar_es_Salaam; `off` disables). It never runs at boot. Sending is
  the in-app master switch, which starts **off**. Manual run, or a preview of
  who would be emailed:
  ```
  npm run compliance:remind -- --dry-run      # plan only, writes nothing
  npm run compliance:remind                   # real run
  ```
  `GET /api/health` → `checks.compliance` is `stale`/`failing` if the job has
  not completed a run in 26 h; each run records duration and heap delta
  (Settings & people → Recent runs).
- **Documents** live in Postgres (`compliance_blobs`), so `pg_dump` and the
  monthly restore drill cover them; the drill re-hashes the newest blob.

## 9. First-time server setup (checklist)

1. Install Node 22+, Nginx; PostgreSQL already runs with Odoo.
2. Clone repo to `C:\apps\LakeCementDashboard`.
3. `cd backend && npm install`
4. Copy `.env.example` → `.env`; fill DB creds, real `JWT_SECRET`,
   `ALLOWED_ORIGIN=http://<server>`, `TRUST_PROXY=1`, `BACKUP_DIR` (second
   disk/share), `PG_BIN`, SMTP + `DIGEST_TO`/`ALERT_TO`.
5. Create the database, run `psql -f db/schema.sql`, `npm run migrate`,
   `npm run seed`.
6. `npm test` (green) → `npm run backup` → `npm run restore:drill` (green).
7. Configure Nginx from `deploy/nginx.conf`; reload; open the site, log in.
8. ADMIN shell: `npm run service:install`.
9. **Reboot the server and verify** the site + `/api/health` come back with
   no manual step, then rotate all seeded passwords (first-login prompt).
