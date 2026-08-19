# Lake Cement MIS — Technical Specification

**Audience:** Odoo development/admin team
**Purpose:** Explain the language, framework, architecture, and data model of the Lake Cement Ltd (Nyati Cement) plant-reporting system ("MIS"), so a connector between it and the live Odoo instance can be scoped and built.
**Repo:** `LakeCementDashboard` (private)
**Status date:** 2026-08-04

---

## 1. What this system is

The MIS is a daily plant-reporting and KPI dashboard system for the Kimbiji cement plant. Department staff (production, quality, dispatch, mining, power, stores, mechanical) fill in daily forms in the browser instead of Excel. A single server-side formula engine computes every KPI from that data, renders dashboards and printable/Excel MIS reports, emails a morning digest, and alerts when data goes missing or the server degrades.

It is **not** an Odoo module. It is a standalone web application that currently owns its own data (manual entry) and is designed to *also* pull facts from the plant's live Odoo instance as a read-only source, department by department, once each integration is scoped. Today, exactly one Odoo-sourced dataset is wired in — weighbridge tickets (quarry/mining) — and it is wired via **manual Excel export/import**, not a live API call. That is the first candidate for automation.

---

## 2. Language & framework summary

| Layer | Technology |
|---|---|
| Backend runtime | **Node.js**, CommonJS modules (`require`/`module.exports`) |
| Backend framework | **Express 5** |
| Database | **PostgreSQL 15+** (`pg` driver, connection pooling, no ORM — raw parameterized SQL) |
| Frontend | Static **HTML + vanilla JavaScript** (no React/Vue/Angular, no build step, no bundler) |
| Auth | **JWT** (`jsonwebtoken`), passwords hashed with **bcrypt** (`bcryptjs`) |
| Validation | **Zod** schemas on every route (`middleware/validate.js`) |
| Scheduled jobs | **node-cron** (in-process, no external job queue) |
| Logging | **Pino** (structured JSON, stdout + rotated files) |
| Metrics | **prom-client** (Prometheus-format `/api/metrics`) |
| Excel I/O | **ExcelJS** (import from and export to `.xlsx`) |
| Email | **Nodemailer** (SMTP) |
| Windows service | **node-windows** (runs the API as a native Windows service, `LakeCementMIS`) |
| Reverse proxy | **Nginx** (serves static frontend, proxies `/api/*` to Node) |
| Alternate hosting | Render.com (`render.yaml` — managed Postgres + web service, used for the previewable/hosted build) |

There is no Python anywhere in the app itself — the only Python file in the repo (`generate_access_matrix.py`) is a one-off offline script that generated an Excel access-matrix report and is unrelated to the running system.

---

## 3. High-level architecture

```
 Browser (plant-floor PC / office PC)
   │  static HTML/JS/CSS, no build step
   │  reads: fetch() JSON        writes: fetch() JSON (JWT bearer token)
   ▼
 Nginx  (production LAN deployment: mis.lakecement.local)
   │  "/"      → serves static files from the repo root
   │  "/api/*" → reverse-proxied to Node
   ▼
 Node.js / Express API   (backend/, port 5000, Windows service "LakeCementMIS")
   │  routes/*.js  → middleware (auth, role, zod validation) → services/*.js
   │  formula engine evaluates KPIs from stored facts on every request
   │  node-cron: 06:00 digest email, */15min watchdog, 02:30 backup
   ▼
 PostgreSQL  (database "lcl_mis")
   runs on the SAME PostgreSQL server/instance that hosts Odoo's databases
   ("PostgreSQL_For_Odoo"), as a separate database + dedicated non-superuser
   role (lcl_admin) — no schema overlap, no shared tables with Odoo today.
```

The frontend never talks to Postgres directly — everything goes through the Express API. There is currently **no live connection from this system to Odoo** (no XML-RPC/JSON-RPC client code exists yet). The one Odoo-originated dataset in the system (weighbridge tickets) arrives as a `.xlsx` export from Odoo that a user imports through the browser, which posts to a bulk-upsert endpoint.

---

## 4. Repository layout

```
LakeCementDashboard/
├── login.html, portal.html         entry point + navigation
├── index.html                      main KPI dashboard
├── daily-report.html               authoritative daily Production Report form
├── forms/                          13 standalone daily-entry forms + shared JS
│   ├── formula-registry.js         ★ single source of truth for ALL KPI math
│   │                                 (loaded by both the backend and the browser,
│   │                                  so the math cannot diverge between them)
│   ├── api-client.js               shared authenticated fetch wrapper
│   ├── form-persist.js             server-first save/load
│   └── offline-queue.js            offline write queue + conflict review
├── analytics.html, mis.html,
│   mines-report.html, power-plant-report.html, reliability.html   dashboards/reports
├── monitor.html                    admin ops dashboard (health, alerts, audit log)
├── backend/                        Express API
│   ├── server.js                   app entry point, middleware pipeline, cron jobs
│   ├── db/                         schema.sql, migrations/, seed.js, connection pool
│   ├── routes/                     one file per API area (see §6)
│   ├── middleware/                 auth (JWT), role/form/kpi access, zod validation
│   ├── services/                   formula engine, digest, watchdog, backup, MIS render/export
│   ├── config/                     role → form/KPI access maps
│   └── scripts/                    migration/seed/backup/restore/service-install CLI scripts
├── deploy/nginx.conf               production reverse-proxy config template
├── render.yaml                     Render.com managed deployment (Postgres + web service)
└── docs/                           RUNBOOK, KPI_REFERENCE (generated), GO_LIVE_CHECKLIST, PROGRESS
```

The frontend has no build step: it is deployed by copying the repo to the server and pointing Nginx's document root at it. There is no npm/webpack build for the client side — only `backend/` has a `package.json` and `node_modules`.

---

## 5. Data model (PostgreSQL)

All tables live in database `lcl_mis`, defined in `backend/db/schema.sql` (canonical current state) with incremental changes tracked in `backend/db/migrations/*.sql` and a `schema_migrations` ledger table.

| Table | Purpose |
|---|---|
| `users` | Login accounts: bcrypt hash, role, department, lockout counters, `token_version` (for instant JWT revocation) |
| `daily_reports` | **One universal table for all department daily forms.** `form_type` (`'production'`, `'dispatch'`, `'quality'`, `'power'`, …) + `record_date` + `shift` identify the row; all actual form fields live in a `JSONB` column called `data`. Unique per `(form_type, record_date, shift)`. |
| `stoppages` | Multi-row-per-day downtime events (equipment, start/end time, duration, reason, category) |
| `weighbridge_tickets` | **The Odoo-sourced dataset.** Deduped by `ticket_no`; columns mirror Odoo's weighbridge export (vendor, vehicle, transfer type, movement type, product, date, net qty). Populated today via manual `.xlsx` import → bulk upsert. |
| `kpi_monthly` | Monthly target vs. actual per department/KPI (manually entered targets; actuals can be formula-computed or manual) |
| `kpi_overrides` | Audited manual overrides of formula-computed KPI values — permanent audit trail, never deleted (soft-cleared) |
| `audit_log` | Every login, form submit, and edit |
| `alerts`, `client_errors` | Operational monitoring (watchdog alerts, browser error reports) |

Design choice worth noting for integration planning: most daily operational data is stored as **flexible JSONB blobs** (`daily_reports.data`), not one column per field. New form fields don't require schema migrations. `weighbridge_tickets` is the exception — it got its own strongly-typed table because it's naturally many-rows-per-day rather than one-blob-per-day, which is closer to how most Odoo data (e.g. stock moves, purchase lines) is shaped. **Future Odoo-sourced datasets will likely follow the `weighbridge_tickets` pattern** (dedicated table, typed columns, natural external key) rather than the JSONB pattern, since they're already relational on the Odoo side.

---

## 6. API surface

Base path `/api`. All routes except `/api/health` require a `Bearer <JWT>` header (`Authorization: Bearer …`). Most writes are further restricted by role (`backend/config/formAccess.js`).

| Route group | Endpoints | Purpose |
|---|---|---|
| `/api/auth` | `POST /login`, `POST /change-password`, `POST /logout`, `GET /me` | Authentication, session management |
| `/api/reports` | `POST /:formType`, `GET /:formType/:date`, `GET /:formType` (range) | Generic daily-form submit/read (backs the JSONB `daily_reports` table) |
| `/api/kpi` | `GET /summary/:year/:month`, `GET /ytd/:dept/:year`, `GET /fiscal/:dept/:fyStartYear`, `GET|PUT /:dept/:year/:month` | Monthly KPI targets/actuals |
| `/api/formula` | `GET /registry`, `GET /eval/:year/:month`, `GET /daily`, `POST /override`, `DELETE /override/:id`, `GET /overrides/:year/:month` | Server-evaluated formula engine — this is what every dashboard renders |
| `/api/mis` | `GET /daily/:date[/html\|/xlsx]`, `GET /monthly/:year/:month[/html\|/xlsx]`, `GET /completeness`, `POST /digest/send` | Rendered MIS reports (print/PDF-ready HTML and Excel export) + manual digest trigger |
| `/api/insights` | `GET /baseline/:formType`, `GET /benchmark/:year/:month`, `GET /stoppages`, `GET /search` | Cross-period analytics |
| `/api/quarry` | `POST /tickets/import` (bulk upsert), `GET /tickets` | **Weighbridge ticket log — the current Odoo integration point** |
| `/api/monitor` | health/alerts/audit/metrics | Admin ops dashboard + Prometheus scrape endpoint |
| `/api/health` | `GET` | Unauthenticated deep health check (DB connectivity, disk, backup age) — used for LAN monitoring and load-balancer health checks |

All request/response bodies are JSON. Zod schemas validate every input at the route boundary before it reaches a handler.

---

## 7. Authentication & authorization model

- **Login:** `POST /api/auth/login` with `{username, password}` → bcrypt compare → JWT signed with `JWT_SECRET`, `expiresIn` from `JWT_EXPIRES_IN` (default 8h). Per-account lockout after N failed attempts (`LOCKOUT_MAX_ATTEMPTS`, default 5), plus IP-based rate limiting on the whole `/api/auth` prefix.
- **Every subsequent request:** `Authorization: Bearer <token>`. `middleware/auth.js` verifies the JWT signature *and* re-checks the user's row in Postgres on every call (cheap indexed lookup) so that logout, password change, or account deactivation revokes access **immediately**, not just at token expiry — implemented via a `token_version` counter compared against the token's `ver` claim.
- **Sliding session:** if a token is within 2 hours of expiry, the server transparently issues a replacement in the `X-Renewed-Token` response header; the frontend swaps it in automatically.
- **Role-based access:** JWT carries `role` and `department`. `requireRole(...)` middleware gates admin-only routes; `config/formAccess.js` maps role → which daily-report `form_type`s that role may submit (mirrored client-side to hide/show UI, but the server-side map is the actual enforcement).

Roles in use: `production`, `pm` (Plant & Machinery), `logistics`, `cpp`, `mining`, `stores`, plus view-only roles `hr`, `it`, `md`, `admin`, `management`, `finance`.

This is a **separate, purpose-built auth system** — it does not use Odoo's users/res.users, and there is currently no SSO between the two systems. If the Odoo team wants to build a connector, it will need its own service account / API credentials issued on the Odoo side; it does not need to touch this app's JWT auth at all (a server-to-server pull job would call Odoo's API using Odoo credentials, then write into this app's Postgres directly or via an internal endpoint).

---

## 8. The formula/KPI engine (why it matters for integration)

`forms/formula-registry.js` is the single source of truth for how every KPI is calculated. It defines:

- **FACTS** — one entry per raw input field, each tagged with a `source`: currently always `'manual'`. The design already anticipates flipping a fact's source to `'odoo'`/`'system'` once that specific field is fed from a live Odoo pull — **no formula code changes needed when that happens**, only the fact's source tag and the ingestion job that populates it.
- **FORMULAS** — plain JavaScript functions over fact keys (deliberately not a string-expression DSL — real formulas here need weighted averages and per-variant field subsets).

This same file is loaded by both the Node backend (`backend/services/formulaEngine.js`, evaluated against Postgres — this is what dashboards actually render) and the browser (offline/demo fallback), so the math is guaranteed identical in both places.

**Why this matters to the Odoo team:** when a department's data is confirmed to already live correctly in Odoo, the plan is to pull it read-only into this system's Postgres (tagging those facts `source: 'odoo'`) rather than re-entering it manually or rebuilding the calculation in Odoo. Two concrete targets are confirmed so far:

1. **"Production Entry Raw Meal"** — the Odoo workflow that computes moisture-adjusted (wet→dry) raw material consumption for limestone/clay/iron ore/sand. That calculation already exists and is correct in Odoo; this system should consume its output, not duplicate it.
2. **Dispatch — daily summary only.** Dispatch will also be sourced from Odoo, but this system needs the **daily aggregate** per channel (Regular Bags, Bulker, Big Bags) and grade — the same shape `forms/formula-registry.js`'s `dispatch_reg_`, `dispatch_blk_`, `dispatch_bag_`, and `dispatch_clinker` facts already use — **not** individual sale orders, invoices, or per-truck dispatch records. The KPI engine only ever needs one total per grade/channel/day; pulling order-level detail would be unnecessary data exposure for no benefit.

---

## 9. Current Odoo relationship (as of this spec)

| Fact | Status |
|---|---|
| Central architecture decision | This Express/Postgres app is the plant's system of record for reporting going forward. An earlier prototype built as a custom Odoo module (`lake_kpi_dashboard`) is shelved/not in use. |
| Live API connection to Odoo | **Scaffolding built, not yet live.** `backend/services/odooClient.js` implements Odoo's JSON-RPC External API (`common.authenticate` + `object.execute_kw`), config-driven via `ODOO_URL`/`ODOO_DB`/`ODOO_USERNAME`/`ODOO_API_KEY`. No pulls are wired up yet — `services/odooSync.js`'s `PULLS` list is empty — because no dataset's exact model/fields are confirmed. `npm run odoo:test -- <model>` lets us self-serve field discovery the moment credentials exist, without waiting on the Odoo team to answer every field question by email. See §11. |
| Database-level connection | **None, and not planned** — Odoo's DB should not be read directly (breaks on Odoo upgrades); any connector should go through Odoo's API. |
| Shared infrastructure | This app's `lcl_mis` Postgres database runs on the **same physical PostgreSQL server instance** that hosts Odoo's own databases, under a separate, dedicated, non-superuser role (`lcl_admin`). No schemas or tables are shared. |
| Data that *has* moved from Odoo into this system | Weighbridge tickets only, via manual `.xlsx` export from Odoo → import through the browser at `mines-report.html` → `POST /api/quarry/tickets/import`. This is the natural first candidate to automate into a scheduled pull. |
| Departments/modules expected to eventually feed in from Odoo | Mining, production, mechanical & electrical, HR, sales, logistics (non-exhaustive — to be scoped per department). Mining is known to not be a standard Odoo app (custom module or may stay manual — needs confirming with the Odoo team). |
| Confirmed integration targets | (1) "Production Entry Raw Meal" — moisture-adjusted raw material consumption. (2) Dispatch — **daily summary only** (per grade/channel totals), explicitly not order/invoice-level detail. See §8. |
| Blocking dependency | The user of this system does not hold Odoo admin/API access themselves; someone else administers Odoo. Connector work needs that person looped in to scope exact models/fields and issue API credentials. |

---

## 10. Deployment & environments

- **Production (current direction, platform confirmed 2026-08-19):** Cloud, under the **Odoo team's ownership** — per the Managing Director's latest direction, superseding the plant-LAN Windows-server plan this repo was originally built around. Platform: a **DigitalOcean droplet**, set up and administered by the Odoo team (India), primary contact GitHub `teckzilla007`. See [`docs/DEPLOYMENT_DIGITALOCEAN.md`](DEPLOYMENT_DIGITALOCEAN.md) for the concrete deploy path, access model, and update workflow. Odoo API credentials for the integration itself are still outstanding (see §12).
- **Originally planned (what the repo's Windows-specific tooling still assumes):** a server on the plant LAN, with the Node API running as a native Windows service (`node-windows`, service name `LakeCementMIS`, port 5000, internal only) behind Nginx (`deploy/nginx.conf`) serving the static frontend and reverse-proxying `/api/*`. `docs/RUNBOOK.md`'s service-install/backup steps describe this path. It hasn't been removed from the repo, but it is no longer the target — don't treat it as the plan without checking first. Both `RUNBOOK.md` and `GO_LIVE_CHECKLIST.md` now carry a banner saying so.
- **Abandoned:** an earlier Render.com + Vercel preview split (managed Postgres + Node web service on Render, static frontend on Vercel) existed via `render.yaml` — confirmed dead and removed from the repo (2026-08-18). Don't resurrect it as a starting point without checking first; it predates the Odoo-team-ownership direction above.
- **Local development:** `preview.bat` (one-click — launches the backend via `npm run dev` and a static frontend preview server, `preview-server.js`, then opens the browser) or manual `cd backend && npm install && npm run migrate && npm run seed && npm run dev`, then open the HTML files directly in a browser (they call `http://localhost:5000/api`).
- **Scheduled jobs** run in-process inside the same Node service via `node-cron`: morning KPI digest email (06:00), operational watchdog/alerting (every 15 min), nightly `pg_dump` backup (02:30).

---

## 11. Odoo connector — what's built, what's next

The transport layer is built; the data layer is intentionally not, pending §12's answers. Concretely:

**Built (this repo, today):**
- `backend/services/odooClient.js` — a dependency-free Odoo External API client using Node's built-in `fetch` against Odoo's `/jsonrpc` endpoint: `version()` (unauthenticated ping), `authenticate()` (caches the uid for the process lifetime), `executeKw()` (generic RPC), plus `searchRead()` / `fieldsGet()` convenience wrappers.
- `backend/scripts/odoo-test-connection.js` (`npm run odoo:test -- [model] [--sample]`) — verifies credentials and, once they work, lists any model's fields (or a few sample records) so we can confirm exact field names ourselves instead of relying on the Odoo team to enumerate them.
- `backend/services/odooSync.js` + `backend/scripts/odoo-sync-once.js` (`npm run odoo:sync`) — a scheduled-pull skeleton mirroring the existing `watchdog.js`/`backup.js` jobs, with an empty `PULLS` list (commented placeholders for both confirmed targets, including the dispatch aggregate-only note) ready to take real pull functions.
- Cron wiring in `server.js`, gated on `ODOO_URL` being set (default 05:00 daily via `ODOO_SYNC_CRON`, `off` disables it outright) — inert today since no config or pulls exist yet.
- `GET /api/monitor/odoo/test` (admin/md/it) — a version+login connectivity check surfaced through the same admin dashboard as the other health checks, so verifying the link doesn't require server access.
- `GET /api/health`'s `checks.odoo` now reports `'not_configured'` vs. `{ok: true, ...}` based on whether `ODOO_URL` is set (config presence only — it deliberately does not make a live Odoo call on every health poll, so a flaky Odoo link can't turn the whole plant dashboard "degraded").
- New `.env` keys: `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY`, `ODOO_SYNC_CRON` (see `backend/.env.example`).

**Not built — blocked on §12:**
1. Any actual pull function for either target (needs a confirmed Odoo model/fields — "Production Entry Raw Meal" and dispatch daily summary are both in line).
2. A dedicated Postgres table per dataset — will mirror `weighbridge_tickets`'s pattern (a natural Odoo record ID as the unique/conflict key, `imported_at`/`updated_at` timestamps) once the shape of the data is known. For dispatch, the destination columns are already effectively known on our side (they match the existing `dispatch_reg_*`/`dispatch_blk_*`/`dispatch_bag_*`/`dispatch_clinker` facts) — what's still open is which Odoo model/view exposes the daily aggregate, and whether Odoo can pre-aggregate it or this system has to.
3. Flipping the corresponding `forms/formula-registry.js` FACTS entries from `source: 'manual'` to `source: 'odoo'` — no formula/dashboard changes required when this happens.

This keeps Odoo as a read-only upstream source and the two databases fully decoupled — no shared schema, no direct DB access into Odoo.

---

## 12. Open questions for the Odoo team

**Status as of 2026-08-19:** items 1–5 and 7 still open. Item 6 (hosting platform) is answered — see below. This is the actual long pole on going live; app-side readiness (this repo) is not the blocker.

1. Who is the Odoo administrator/API owner who can issue a service-account or API-key credential for a read-only integration?
2. For "Production Entry Raw Meal": what is the exact Odoo model/module name, and which fields hold the moisture-adjusted (dry-basis) consumption figures per material (limestone/clay/iron ore/sand)?
3. For dispatch: what Odoo model/module tracks sales/dispatch, and can it expose (or can a view be built to expose) an **already-aggregated daily total per grade and channel** (Regular Bags/Bulker/Big Bags × 42.5R/42.5N B-M/42.5N/32.5N/OPC 42.5N, plus clinker) — rather than this system having to pull and sum individual order lines itself?
4. Is mining tracked in a standard Odoo module, a custom module, or not in Odoo at all? (Needed to decide whether weighbridge-ticket import can become a live pull, or must stay manual.)
5. For the other departments in scope (mechanical & electrical, HR, sales, logistics) — which are on standard Odoo apps (e.g. `hr`, `sale`, `stock`) vs. custom modules, so field-level mapping can be scoped per department rather than assumed.
6. ~~Now that production hosting is planned as cloud infrastructure under the Odoo team's ownership (§10): which cloud platform/account should this deploy to, and who sets up and administers that environment?~~ **Answered 2026-08-19:** DigitalOcean, administered by the Odoo team (India); primary contact GitHub `teckzilla007`. Deploy path documented in `docs/DEPLOYMENT_DIGITALOCEAN.md`. Whether Postgres runs on the same droplet or a DigitalOcean Managed Database is still the Odoo team's call (both are documented, §2.4 of that guide).
7. *(New, 2026-08-18)* For Purchases: the exact Odoo technical field names behind the "PO For" and "Purchase Type" labels on the PO form (custom fields, not stock Odoo), and confirmation of whether "PR No" is a real Purchase Requisition record or just a reference number on the PO. Blocks `purchasesOdoo.js`'s `fetchCategoryGrid` — currently a permanent, honest `not_mapped` stub (see `backend/services/purchasesOdoo.js`).
8. *(New, 2026-08-18)* Once a hosting platform is chosen (Q6): how will this app reach Odoo over the network? Odoo currently sits on the plant LAN (`ODOO_URL`/`ODOO_DISPATCH_URL` point at plant-internal addresses). If the app moves to infrastructure outside that LAN, something needs to bridge them — a VPN/tunnel, a firewalled public endpoint, or hosting both under the same network. This is a real architecture decision, not a config change.
