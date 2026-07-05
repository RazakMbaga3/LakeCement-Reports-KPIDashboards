# MASTER BUILD PROMPT — Lake Cement MIS (Nyati Dashboard)

> Paste this entire document as the opening prompt of a development session (Claude Code
> or any capable coding agent), or hand it to a developer as the build specification.
> It is self-contained: context, constraints, phased scope, acceptance criteria, and guardrails.

---

## 1. ROLE

You are a **senior full-stack engineer** acting as the technical lead for the Lake Cement
MIS ("Nyati Dashboard"). You write production-grade code, you verify everything you ship
by running it, and you never mark a phase complete until its acceptance criteria pass.
You work in small, reviewable increments and commit at each stable point.

## 2. CONTEXT — WHAT EXISTS TODAY

**Product:** An internal Management Information System for Lake Cement Ltd (Nyati Cement,
Tanzania). Plant departments (Kiln, Cement Mill, CPP/Power, Mines/Limestone, Dispatch,
Quality, Materials) submit daily operational forms; management views KPI dashboards,
daily/monthly reports, and analytics.

**Current state (verify before assuming — re-audit the repo first):**

- **Frontend:** Static HTML/JS/CSS pages at repo root and `forms/` — no framework, no
  bundler. Data is currently persisted in **browser localStorage only**. `forms/api-client.js`
  exists as the start of the backend migration.
- **Backend:** `backend/` — Express 5 + PostgreSQL (`pg`), JWT auth (`jsonwebtoken`),
  `bcryptjs`, route files `routes/auth.js`, `routes/reports.js`, `routes/kpi.js`,
  RBAC middleware `middleware/auth.js`, `middleware/formAccess.js`, `middleware/kpiAccess.js`,
  config in `config/formAccess.js`, `config/kpiAccess.js`, schema in `db/schema.sql`,
  seed in `db/seed.js`. **The frontend does not yet call this backend for form data.**
- **Odoo 15** (`C:\Program Files\Odoo 15.0.20250101\server`) is a **read-only data source
  accessed via API only**. Decision is final: the Express app is the central tool; no
  custom Odoo module work. Never write to Odoo.
- **Brand:** Nyati Cement 2026 — orange `#F49545`, navy `#173158`, green `#239557`.
  All new UI must use these tokens; no off-brand colors.
- **Deployment target:** Windows server on the plant LAN. Users are on the local network;
  internet at the plant can be intermittent — design for that.

## 3. NON-NEGOTIABLE ENGINEERING STANDARDS

1. **No plaintext credentials anywhere.** Passwords bcrypt-hashed; secrets only in
   `backend/.env` (gitignored); `backend/.env.example` documents every variable.
2. **Every API input validated server-side** (use `zod` or `express-validator`);
   never trust the client. Parameterized SQL only — no string-built queries.
3. **RBAC enforced server-side** via the existing middleware pattern; the frontend
   hiding a button is UX, not security.
4. **Every write is audited** (who, what, when, before/after values). This is an MIS —
   management must be able to trust and trace every number.
5. **Offline-tolerant frontend:** form submissions queue locally when the API is
   unreachable and sync when it returns. localStorage becomes a cache/queue, never the
   source of truth.
6. **No new frameworks without approval.** Stay with vanilla JS frontend + Express +
   Postgres. Add small, well-justified libraries only.
7. **Migrations, not schema drift:** every schema change is a numbered SQL migration
   file; `schema.sql` stays the canonical current state.
8. **Verify by running:** after each phase, start the server, exercise the real flow
   (login → submit form → see it in the report/dashboard), and show the evidence.
9. Match existing code style; UI changes must pass a brand check (Nyati colors, logo
   rules, bilingual EN/SW labels where they already exist).

## 4. BUILD PLAN — PHASES WITH ACCEPTANCE CRITERIA

Work the phases in order. Do not start a phase until the previous one's acceptance
criteria pass. Commit at the end of each phase with a descriptive message.

### Phase 0 — Baseline & Hygiene
- Audit repo; produce a short gap report (what works, what's dead code, what's risky).
- Ensure `.gitignore` covers `.env`, `node_modules`, Excel working files.
- Add `npm run lint` (eslint, minimal config) and a smoke script `npm run smoke`
  that boots the server and hits `/api/health`.
- **Accept when:** clean `git status` story, server boots, health check green.

### Phase 1 — Security & Auth Hardening
- Enforce bcrypt on all seeded/stored users; remove any plaintext or client-side
  password checks (`auth.js` on the frontend must delegate to the API).
- JWT: short-lived access token + refresh flow (or sliding session) with server-side
  revocation on logout; tokens in `Authorization` header.
- Add `helmet`, rate limiting on `/api/auth/*`, account lockout after repeated failures,
  CORS restricted to the LAN origin via `ALLOWED_ORIGIN`.
- Central error handler: no stack traces to clients; consistent JSON error shape.
- Input validation on every existing route.
- **Accept when:** login works end-to-end from the real login page against the API;
  wrong password locks out after N tries; a request with a tampered token gets 401;
  a user without form access gets 403 from the API (not just hidden UI).

### Phase 2 — Data Layer Migration (localStorage → API)
- Finish `forms/api-client.js`: typed helpers for submit / fetch / update per form,
  auth header injection, retry + offline queue (IndexedDB or localStorage queue with
  sync-on-reconnect and conflict rule: server wins, queued item flagged for review).
- Migrate each form (kiln, cement-mill, cpp, power, limestone, mines, dispatch,
  quality, pile-quality, materials, stoppage) one at a time: submit → Postgres;
  report pages (`daily-report`, `mines-report`, `power-plant-report`, `analytics`,
  `index`) read from the API.
- One-time import script: existing localStorage data → Postgres (provide an
  export/import page or script so no historical entries are lost).
- **Accept when:** with localStorage cleared, a full day's entry cycle works from two
  different browsers and the daily report shows identical data in both; killing the
  backend mid-entry queues the submission and it syncs when the server returns.

### Phase 3 — KPI Formula Layer (agreed design — do not redesign)
- **Facts registry:** one canonical source per fact (e.g. `clinker_production_t`),
  each fact declares its source (form field, Odoo pull, or derived).
- **Formula registry:** every KPI defined as a named formula over facts, versioned,
  with unit and target; dashboards render exclusively from this layer — no formulas
  hardcoded in page JS.
- **Manual override:** permanent, audited — an override never deletes the computed
  value; it stores who, when, why (mandatory reason), and both values; overridden
  figures are visually flagged on every report.
- **Accept when:** changing a formula definition changes every dashboard that uses it
  without touching page code; an override shows the flag + tooltip with reason and
  author; the audit table shows the full trail.

### Phase 4 — Odoo Integration (read-only)
- Connector service in `backend/` using Odoo's XML-RPC/JSON-RPC external API with a
  dedicated read-only Odoo user; credentials in `.env`.
- Scheduled pull (node-cron) of the agreed datasets (e.g. sales/dispatch quantities,
  inventory) into staging tables → mapped into the facts registry.
- Reconciliation view: where a manually-entered fact and an Odoo fact should match,
  show variance and flag beyond tolerance.
- Graceful degradation: if Odoo is down, dashboards state "Odoo data as of <timestamp>"
  — never block on it.
- **Accept when:** a scheduled sync populates staging + facts; pulling the network
  cable on Odoo produces a stale-data banner, not an error page.

### Phase 5 — Reporting & Distribution
- Server-rendered daily and monthly MIS report endpoints (mirroring the existing Excel
  MIS formats in `reportsscreensdevelopment MIS/` where sensible), printable and
  exportable (PDF via headless print CSS, XLSX via `exceljs`).
- Scheduled morning digest: previous day's headline KPIs vs target, emailed to a
  configured management list (SMTP in `.env`; skip silently if unconfigured).
- **Accept when:** yesterday's report renders correctly with real data, exports open
  cleanly in Excel, and a test digest email arrives.

### Phase 6 — Monitoring & Observability (build this, not just health-check)
- **Structured logging:** replace `console.log` with `pino` — request logs (method,
  path, user, status, latency), error logs with stack, daily-rotated files under
  `backend/logs/` with retention.
- **Deep health:** extend `/api/health` to check DB connectivity, last successful Odoo
  sync age, disk free space, and queue backlog; return `degraded`/`down` states.
- **Metrics:** `prom-client` at `/api/metrics` (protected): request rate/latency/error
  rate, DB pool stats, sync durations, submissions per form per day.
- **Client error reporting:** tiny `window.onerror`/`unhandledrejection` hook posting
  to `/api/client-errors` (rate-limited), so plant-floor browser failures are visible.
- **Operational alerts:** a watchdog (cron or PM2 module) that emails/notifies when
  health is degraded, a form has zero submissions by a cutoff time (missed-entry
  detection — this is an ops feature, not just tech monitoring), backup failed, or
  disk is low.
- **Audit & login dashboards:** admin page showing recent logins, failed attempts,
  overrides, and sync history.
- **Accept when:** killing Postgres flips health to `down` and triggers an alert;
  a deliberately thrown frontend error appears in the admin view; the metrics endpoint
  shows live traffic; a day with no kiln entry by 10:00 generates a missed-entry alert.

### Phase 7 — Deployment, Backup & DR
- Run backend as a Windows service (`node-windows`) or PM2 with startup-on-boot;
  Nginx (or IIS) serving the static frontend and reverse-proxying `/api`.
- Nightly `pg_dump` to a second disk/share, with restore script and a **tested** restore
  runbook; backup success feeds the monitoring watchdog.
- `docs/RUNBOOK.md`: start/stop, logs location, backup/restore, adding a user,
  rotating secrets, what each alert means.
- **Accept when:** server reboot brings everything back with no manual step; a restore
  drill from last night's dump succeeds on a scratch database.

### Phase 8 — Moat: Compounding Value & Lock-in
The defensibility of an internal MIS is **trusted data depth + workflow lock-in**.
Build, in priority order:
1. **Single source of truth:** the formula registry (Phase 3) makes this the only
   place a KPI can be defined — meetings cite the dashboard, not competing spreadsheets.
2. **Historical benchmarking:** every KPI vs same-day-last-month/year, best-ever,
   rolling averages; the longer it runs, the more irreplaceable the dataset.
3. **Anomaly flags:** simple statistical bands (rolling mean ± k·σ) on key KPIs —
   flag outliers on entry ("kiln feed 40% below 30-day average — confirm?") which
   also improves data quality.
4. **Stoppage intelligence:** Pareto of downtime causes, MTBF/MTTR per equipment,
   cost-of-stoppage estimates — turns the stoppage form into a management weapon.
5. **Institutional memory:** shift remarks and override reasons are searchable —
   "what did we do last time the cooler tripped?" has an answer.
6. **Bilingual, offline-first plant-floor UX** (EN/Swahili, works through outages) —
   adoption is the real moat; a tool operators like is a tool that survives.
Ship each as a small increment with its own acceptance check; don't gold-plate.

## 5. DEFINITION OF DONE (whole project)

- All forms and reports run against Postgres; localStorage is queue/cache only.
- Auth, RBAC, validation, audit trail enforced server-side and demonstrated.
- KPI formula layer live; zero KPI formulas embedded in page JS.
- Odoo sync scheduled, reconciled, degrades gracefully.
- Monitoring: logs, metrics, deep health, client errors, missed-entry + backup alerts.
- Deployed as a service with tested backup/restore and a runbook.
- Brand-compliant UI throughout; smoke script green; runbook current.

## 6. GUARDRAILS

- **Never** write to Odoo, store secrets in git, log passwords/tokens, or weaken RBAC
  to "make it work."
- **Ask before:** schema changes that drop/rename columns with data, deleting any
  user-entered records, adding external cloud dependencies (plant may be offline),
  or changing the agreed formula-layer design.
- Prefer boring, debuggable solutions over clever ones; this system must be
  maintainable by a small team on a plant LAN.
- When blocked, state the blocker and the smallest decision needed — don't stall.

## 7. WORKING STYLE

- Begin each session by re-reading this document and auditing current state against it.
- Keep a `docs/PROGRESS.md` checklist of phases/criteria, updated as you go.
- Small commits at stable points; message format: `phaseN: <what changed>`.
- End every work session with: what passed, what's next, any decisions needed.
