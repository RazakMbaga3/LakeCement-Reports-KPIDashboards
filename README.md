# Lake Cement MIS — Nyati Dashboard

Daily plant-reporting and KPI system for **Lake Cement Ltd** (Nyati Cement),
Kimbiji, Tanzania. Departments enter their daily reports in the browser;
the system computes every KPI in one audited formula engine, renders
dashboards and branded MIS reports (HTML/print + Excel), emails a morning
digest, and alerts when data goes missing or the server degrades.

It replaces the plant's spreadsheet-based daily reporting (the source Excel
workbooks live in `reportsscreensdevelopment MIS/` as reference material).

## Architecture in one paragraph

Static HTML/JS frontend (this repo's root, served by Nginx in production) →
`/api` reverse-proxied to a Node/Express backend (`backend/`, port 5000) →
PostgreSQL (`lcl_mis`). All KPI math lives in
[`forms/formula-registry.js`](forms/formula-registry.js) and is evaluated
server-side by one engine; browsers queue writes offline and sync
automatically when the connection returns. The backend schedules its own
jobs: morning digest (06:00), watchdog alerts (every 15 min), nightly
backup (02:30). Odoo is a **read-only data source** to be wired per-fact
later (Phase 4) — the Odoo module itself is shelved.

## Quick start (development)

```powershell
# one-click: starts the backend and opens the app
.\run.bat

# or manually
cd backend
npm install
copy .env.example .env     # fill in DB credentials at minimum
npm run migrate
npm run seed               # dev/test users (forced password change on first login)
npm run dev                # http://localhost:5000
# then open login.html in a browser
```

**Production hosting:** a DigitalOcean droplet administered by the Odoo
team — see [docs/DEPLOYMENT_DIGITALOCEAN.md](docs/DEPLOYMENT_DIGITALOCEAN.md)
for server setup and how code updates reach the live server.
[docs/RUNBOOK.md](docs/RUNBOOK.md) and
[docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md) describe an earlier
on-prem Windows-server plan that DEPLOYMENT_DIGITALOCEAN.md has superseded
for hosting purposes; kept for reference (their non-hosting sections —
backups, user admin, alert meanings — still apply).

## Documentation

| Document | What it is |
|---|---|
| [docs/DEPLOYMENT_DIGITALOCEAN.md](docs/DEPLOYMENT_DIGITALOCEAN.md) | **Current production deployment guide** — DigitalOcean droplet setup, access model, auto-deploy-on-push |
| [docs/TECHNICAL_SPEC.md](docs/TECHNICAL_SPEC.md) | Architecture, data model, formula layer, Odoo integration, open questions |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operations manual: logs, backup & restore, users, secrets, alerts (hosting sections superseded — see above) |
| [docs/KPI_REFERENCE.md](docs/KPI_REFERENCE.md) | **Generated** definition of every KPI and fact — regenerate with `npm run docs:kpi` (in `backend/`) after editing the formula registry |
| [docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md) | One-time cutover plan: hardening, parallel run vs Excel, sign-off, rollback |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Build-phase tracker (Phases 0–8) with acceptance status and audit findings |
| [docs/MASTER_BUILD_PROMPT.md](docs/MASTER_BUILD_PROMPT.md) | The original phased build plan |

## Repo map

```
├── login.html, portal.html      entry + navigation
├── index.html                   KPI dashboard (renders /api/formula output)
├── daily-report.html            daily forms hub
├── forms/                       13 standalone entry forms + shared JS
│   ├── formula-registry.js      ★ single source of truth for all KPI math
│   ├── api-client.js            authenticated fetch wrapper
│   ├── form-persist.js          server-first save/load, offline cache
│   └── offline-queue.js         offline WRITE queue with conflict review
├── analytics.html               trends & charts
├── mis.html                     MIS view
├── mines-report.html            Daily TMH + mining MIS engine (weighbridge tickets)
├── power-plant-report.html      captive power plant (CPP) report
├── reports-export.html          print/PDF + Excel export, digest trigger
├── monitor.html                 admin ops dashboard (health, alerts, audit)
├── memory.html                  institutional-memory search
├── import-local.html            one-time localStorage → server import
├── backend/                     Express API, formula engine, jobs, scripts
│   ├── db/                      schema, migrations, seed
│   ├── routes/ services/        API + digest/watchdog/backup/MIS renderers
│   ├── config/formAccess.js     which role may submit which form
│   └── scripts/                 accept-phase*, smoke, backup, restore, docs
├── deploy/                      nginx configs, pm2 config, remote deploy script
├── .github/workflows/deploy.yml auto-deploy on push to main (DigitalOcean)
└── docs/                        see table above
```

## Roles (who submits what)

Defined server-side in
[`backend/config/formAccess.js`](backend/config/formAccess.js) (mirrored
client-side in `auth.js` — keep in sync):

| Role | Submits |
|---|---|
| production | production, quality, limestone, pile-quality |
| pm (Plant & Machinery) | kiln, cement-mill, stoppage, power-cons |
| logistics | dispatch |
| cpp | power-plant, cpp |
| mining | mines |
| stores | materials |
| hr, it, md, admin, management, finance | view-only (no form submission) |

## Backend commands (`cd backend`)

| Command | Purpose |
|---|---|
| `npm run dev` / `npm start` | run the API (nodemon / plain) |
| `npm test` | lint + smoke boot (run before every deploy) |
| `npm run migrate` / `npm run seed` | apply `db/migrations/` / seed users |
| `npm run accept:phase1…8` | full acceptance suites per build phase |
| `npm run backup` / `npm run restore:drill` | manual pg_dump / safe restore rehearsal |
| `npm run watchdog` | run the alert checks once |
| `npm run docs:kpi` | regenerate docs/KPI_REFERENCE.md from the registry |
| `npm run service:install` / `service:uninstall` | Windows service (admin shell, on-prem only) |

## Rules of the road

- **KPI math changes happen only in `forms/formula-registry.js`.** Bump the
  formula's `version`, update its `notes`, run `npm run docs:kpi`, and
  commit the registry and the regenerated reference together.
- Never commit `backend/.env` (template: `backend/.env.example`).
- Deploying an update to production = push to `main` — the GitHub Actions
  workflow (`.github/workflows/deploy.yml`) deploys automatically to the
  DigitalOcean droplet. See
  [docs/DEPLOYMENT_DIGITALOCEAN.md](docs/DEPLOYMENT_DIGITALOCEAN.md) §3.
