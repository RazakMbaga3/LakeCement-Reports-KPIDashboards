# PROGRESS — Lake Cement MIS build plan tracker

Companion to [MASTER_BUILD_PROMPT.md](MASTER_BUILD_PROMPT.md). Update as criteria pass.
Last audit: 2026-07-05.

## Phase 0 — Baseline & Hygiene — ✅ DONE (2026-07-05)
- [x] Repo audit / gap report (below)
- [x] .gitignore hardened (root: node_modules, .env, Excel lock files, logs)
- [x] `npm run lint` — eslint flat config, backend only
- [x] `npm run smoke` — boots server on a scratch port, asserts `/api/health` 200
- [x] Accept: server boots, health green, git history clean

## Phase 1 — Security & Auth Hardening — ✅ DONE (2026-07-05)
- [x] bcrypt on all users (seed.js, 12 rounds); no plaintext user array on frontend
- [x] Frontend login/logout/me delegate to API (auth.js)
- [x] Login/logout/lockout/password-change all write to audit_log
- [x] Server-side revocation: JWT carries `ver`, checked against users.token_version
      on every request; logout/password-change bumps it (all devices). Sliding
      session via X-Renewed-Token header when < 2h of token life remains.
- [x] helmet
- [x] Rate limiting on /api/auth/login + /change-password (AUTH_RATE_LIMIT/5min) + account lockout
      (LOCKOUT_MAX_ATTEMPTS → locked LOCKOUT_MINUTES)
- [x] CORS via ALLOWED_ORIGIN (comma-separated list; boot warning when `*`)
      — must be set to the real origin at deployment (Phase 7)
- [x] zod validation on every route (middleware/validate.js); consistent
      { error } shape; central error handler logs stack, client sees generic 500
- [x] Seed-password exposure mitigated: must_change_password forces a new
      password at first login (migration 001 flagged all existing users);
      login.html shows a set-new-password panel. Rotate at go-live regardless.
- [x] Migrations system: db/migrate.js + db/migrations/ (`npm run migrate`)
- [x] Accept criteria: scripts/accept-phase1.js — 19 checks green 2026-07-05
      (tampered token 401, lockout 423, RBAC 403, revocation, must-change gate,
      validation 400s). Browser-side login/change-password JS syntax-checked.

## Phase 2 — Data Layer Migration — ✅ DONE (2026-07-05)
- [x] forms/api-client.js complete (submitForm / getForm / getFormRange, auth
      header, err.status on HTTP failures for retry/permanent classification)
- [x] form-persist.js: server-first save/load, localStorage demoted to offline cache
- [x] report-loader.js / analytics.js / kpi-data.js: server-first reads (verified)
- [x] All 13 form types verified submitting to Postgres end-to-end and reading
      back identically from a second authenticated session (accept-phase2 Part A)
- [x] Offline WRITE queue: forms/offline-queue.js — retryable failures
      (offline/401/5xx) queue locally; auto-flush on 'online' event, every 60 s,
      and on page load; status pill bottom-left with review panel.
      Conflict rule: server wins — if the server copy is newer than the queued
      item it is flagged for review ("Use mine" / "Keep server"); permanent
      rejections (validation/403) also flag for review instead of retrying.
      Wired into form-persist.js, inline-edit.js, and all 15 pages.
- [x] One-time import: import-local.html scans this browser's nyati-* entries,
      skips dates already on the server (server wins), imports the rest via the
      API per role; JSON backup download included. Old positional-only snapshots
      are backup-only (no field names to map).
- [x] Accept: scripts/accept-phase2.js — 20 checks green 2026-07-05
      (13-form round-trip + second-session identity; queue: server-down keeps,
      reconnect syncs, newer-server conflict, both resolutions, 403 review).
      Kill-server-mid-entry is covered by B1/B2 against the real queue module.

## Phase 3 — KPI Formula Layer — ✅ DONE (2026-07-06)
- [x] forms/formula-registry.js — the single source of truth: 38 FACTS (each
      declaring one source: manual now, flip to 'odoo' per-fact in Phase 4)
      and 11 FORMULAS as plain reviewed functions (per the agreed design —
      no string DSL), each with label/unit/dp/target/signage/version.
      Loaded by BOTH the backend engine and the browser (UMD), so the
      offline/demo path in analytics.js runs the identical functions.
- [x] backend/services/formulaEngine.js — joins each day's facts across
      forms, evaluates daily + monthly (avg / sum / production-weighted),
      applies active overrides. Routes: /api/formula/{registry,eval,daily,
      override,overrides}.
- [x] Manual override (migration 002, kpi_overrides): reason mandatory,
      admin/md only, computed value preserved alongside, superseding keeps
      the old row, clearing never deletes, every action in audit_log.
      Dashboard cells flag overrides (edited-cell) with a tooltip showing
      who/when/why + the underlying formula value.
- [x] kpi-data.js and analytics.js contain ZERO formula math (asserted by
      the acceptance script) — the duplicated STE/SPC/free-lime formulas
      and twice-hardcoded targets are gone; targets now render from the
      registry. Editing an auto cell prompts for the mandatory reason and
      posts a server override.
- [x] Accept: scripts/accept-phase3.js — 25 checks green 2026-07-06
      (all 11 formulas vs independently hand-coded arithmetic, daily
      series, override RBAC/reason/supersede/clear/permanence/audit,
      structural no-math-in-pages). "Change formula → all dashboards
      change" holds structurally: pages render only /api/formula output.
- [x] RESOLVED 2026-07-09: Specific Thermal Energy formula's ×1000 factor
  confirmed wrong against the source Excel (Production Report / Master
  production report — Q54 = NCV × coal%, no ×1000; coal MT and clinker MT
  cancel directly). Fixed in formula-registry.js (v1→v2) and the leftover
  inline duplicate in kiln-form.html; accept-phase3.js expectation updated
  to match.
- [x] RESOLVED 2026-07-09: Specific Power Consumption formulas rebuilt to
  match the source Excel's 3-layer method (per-department kWh → per-ton
  clinker → clinker-factor-scaled to per-ton equivalent cement), using new
  cement-mill facts (cm_clinker_cons + CM1/CM2 grade tonnages). Also found
  Cement Mill-1's kWh/production inputs on power-form.html existed with no
  data-field — CM-1 power was silently excluded from every SPC KPI and the
  form's own live-preview total. Wired up (pwr_cm1_kwh, pwr_cm1_prod_mt)
  plus a same class of gap on Packing Plant-2 (pwr_packing2_kwh). "Up to
  Clinker" remains a documented simplification (direct kWh/clinker-MT,
  not the Excel per-department 1.55×/coal%/limestone-ratio build) because
  Crusher/Raw Mill/Coal Mill output tonnages aren't captured by any form
  yet — needed for full parity. accept-phase3.js fixtures/expectations
  updated and verified against the live registry code.

- [x] RESOLVED 2026-07-17: accept-phase3 had silently broken (4 power KPIs
  null) after the ownership transfer gave power-cons to the pm role — the
  script still seeded it as the cpp user and its submit helper ignored the
  403. Seed now submits power-cons as pm and submit() throws on non-2xx so
  RBAC drift fails loudly. 25/25 green again. Also added `notes` metadata
  per formula and `npm run docs:kpi` → generated docs/KPI_REFERENCE.md.

## Phase 4 — Odoo Integration (read-only) — ⬜ NOT STARTED

## Phase 5 — Reporting & Distribution — ✅ DONE (2026-07-06)
(Phase 4 Odoo integration intentionally skipped for now — blocked on
read-only Odoo credentials + dataset selection from the user.)
- [x] Server-rendered daily + monthly MIS reports (backend/services/misReport
      → misRender/misExcel; routes /api/mis/...): JSON payload, printable
      branded HTML (browser print → PDF, no headless-browser dependency),
      and XLSX via exceljs (KPI Summary sheet + one sheet per form; numbers
      stay numbers). KPIs come from the formula layer — overrides carry the
      ⚑ flag + who/why note into both HTML and Excel.
- [x] Daily report includes a missing-submissions warning (precursor to
      Phase 6 missed-entry alerts).
- [x] Morning digest (services/digest.js): yesterday's KPIs vs target +
      missing forms, emailed via SMTP config in .env on DIGEST_CRON
      (default 06:00); skips silently when unconfigured; manual trigger
      POST /api/mis/digest/send (admin/md). DIGEST_TRANSPORT=json exercises
      the real pipeline without a mail server. **Real SMTP credentials
      still needed from the user for live email.**
- [x] Frontend: reports-export.html — date/month pickers, print view (blob
      tab), Excel download, admin digest button.
- [x] Accept: scripts/accept-phase5.js — 10 checks green 2026-07-06 (daily
      + monthly JSON/HTML/XLSX incl. parsing the workbook back and override
      propagation; digest pipeline + RBAC).
- Deferred: pixel-mirroring the 30+ departmental Excel MIS templates in
  reportsscreensdevelopment MIS/ — the generated workbook is a clean
  general format; specific template replicas can be added per department
  on request.

## Phase 6 — Monitoring & Observability — ✅ DONE (2026-07-06)
- [x] Structured logging: pino (services/logger.js) → stdout + daily-rotated
      files in backend/logs/ (14-day retention); pino-http request logs with
      user/status/latency; central error handler logs stacks via pino.
- [x] Deep health: /api/health checks DB latency, disk free (DISK_MIN_FREE_GB),
      backup age (once BACKUP_DIR is set, Phase 7) → ok/degraded/down, HTTP 503
      when down. Odoo check joins in Phase 4 ('not_configured' until then).
- [x] Metrics: prom-client at /api/metrics (admin/md/it JWT or static
      METRICS_TOKEN for scrapers) — request rate/latency/status by route
      template, pg pool gauges, form_submissions_total by form type.
- [x] Client error reporting: forms/client-errors.js (all 15 pages +
      monitor.html) posts window.onerror/unhandledrejection to
      /api/client-errors (rate-limited, soft-attributed, 60-day retention).
- [x] Watchdog (services/watchdog.js, cron every 15 min + manual runs):
      health degraded/down, disk low, backup stale, and missed-entry
      detection (MISSED_ENTRY_FORMS after MISSED_ENTRY_CUTOFF). One alert
      per kind per day (alerts table dedupe), emailed to ALERT_TO via the
      shared mailer; when the DB itself is down the email still goes out.
      CLI: npm run watchdog.
- [x] Admin dashboard: monitor.html — live health chips, alerts, browser
      errors, login/lockout events, KPI override trail; manual "run checks".
- [x] Accept: scripts/accept-phase6.js — 16 checks green 2026-07-06
      (deep health ok + 503-when-down, metrics auth/content/submission
      counter, client errors anonymous+attributed, RBAC, missed-entry
      fire + email + dedupe + table row, DB-down watchdog still emails,
      log files on disk).
- NOTE: analytics.html/kiln-form.html (and some other pages) contain
  pre-existing UTF-8 double-encoding (— rendered as â€“ etc.) dating from
  before this repo's git history — cosmetic (mostly CSS comments); a
  one-off re-encode cleanup can be done separately if desired.

## Phase 7 — Deployment, Backup & DR — ✅ DONE (2026-07-06)
- [x] Nightly pg_dump (services/backup.js, BACKUP_CRON default 02:30 into
      BACKUP_DIR, custom format, BACKUP_KEEP_DAYS retention; `npm run backup`).
      pg tools auto-resolved incl. the Odoo-bundled PostgreSQL layout (PG_BIN
      override). Backup freshness feeds /api/health + watchdog alerts (wired
      in Phase 6, verified live here).
- [x] Restore tooling: `npm run restore:drill` restores the newest dump into
      a scratch DB, verifies tables + user count vs live, drops it — never
      touches the live database. scripts/restore.js restores into a NEW
      database with a runbook'd switchover (refuses to overwrite live).
      PG_ADMIN_* override for CREATE DATABASE rights; lcl_admin was granted
      CREATEDB once on this machine.
- [x] Windows service: `npm run service:install` / `service:uninstall`
      (node-windows) — auto-start at boot + crash restart. TRUST_PROXY env
      for correct client IPs behind the proxy.
- [x] deploy/nginx.conf — static frontend + /api reverse proxy template.
- [x] docs/RUNBOOK.md — start/stop, logs, backup/restore/drill + switchover,
      user admin (add/unlock/force-logout/disable), secret rotation, alert
      meanings, update procedure, first-time server checklist.
- [x] Accept: scripts/accept-phase7.js — 8 checks green 2026-07-06 (dump
      valid, retention prune, health ok-with-fresh/degraded-when-missing,
      REAL restore drill on a scratch DB, collateral present).
- ⚠ SECURITY FINDING: Odoo's bundled Postgres superuser `openpg` still has
  the default password (openpgpwd). Documented in RUNBOOK §6 — change it.
- Remaining for go-live on the plant server (needs the machine/user):
  run the first-time checklist in RUNBOOK §9 — install service (admin
  shell), set BACKUP_DIR to a second disk/share, configure Nginx, reboot
  test. All scripts are ready; the reboot criterion is verified at
  deployment, not on this dev laptop.

## Phase 8 — Moat features — ✅ DONE (first tranche, 2026-07-06)
- [x] Anomaly flags at entry: submitting a form fetches the 30-day per-field
      baseline (/api/insights/baseline) and the confirm dialog warns on
      values outside mean ± 2σ ("kiln_prod_mt: 1200 is 40% below the 30-day
      average"). Advisory only, never blocks, silent when offline.
- [x] Historical benchmarking (/api/insights/benchmark): every KPI vs prev
      month, same month last year, best-ever (direction-aware via signage)
      and rolling-3 — and the columns render in the monthly MIS report
      (HTML + Excel), so management reads each number against its history.
- [x] Stoppage intelligence (/api/insights/stoppages): Pareto of downtime
      causes with cumulative %, per-equipment hours/MTTR/MTBF/availability,
      parsed from the stoppage form's equipment × cause matrix.
- [x] Institutional memory (/api/insights/search + memory.html): full-text
      search across all form entries, KPI override reasons, and the audit
      trail — "what did we do last time the cooler tripped?" has an answer.
- [x] Accept: scripts/accept-phase8.js — 12 checks green 2026-07-06
      (baseline math vs hand stats, benchmark periods/best-ever/rolling,
      report columns, Pareto + MTTR/MTBF, search across all three sources,
      structural wiring of the entry check). accept-phase5 re-run green
      after the report layout change.
- Deferred (next tranche, on request): stoppage insights UI page/charts,
  benchmark chips on the KPI dashboard itself, cost-of-stoppage estimates
  (needs a TZS/hour rate per equipment from Finance), bilingual EN/SW
  labels across the plant-floor forms.

---

# AUDIT FINDINGS (Phase 0 gap report, 2026-07-05)

## What works
- **Backend** (`backend/`): Express 5 + pg pool; JWT login with bcrypt compare;
  `requireAuth` + `formAccess`/`kpiAccess` middleware; routes for auth, reports
  (daily forms), kpi; global error handler + 404 handler; DATE columns returned as
  plain strings (timezone bug already fixed in db/index.js).
- **Schema**: `users`, `audit_log`, `daily_reports`, `stoppages`, `kpi_monthly`
  with sensible indexes.
- **Frontend**: auth.js is API-backed (no plaintext credential array); permission
  matrix drives tab/dept visibility; form-persist + report-loader are server-first
  with localStorage as offline read cache.

## Gaps / risks (drive Phases 1–2 next)
1. **No offline WRITE queue** — submitting while the server is down saves only to
   localStorage with no replay; data can silently stay on one browser. (Phase 2)
2. **JWT is stateless with no revocation** and 8h expiry; logout only deletes the
   token client-side. (Phase 1)
3. **No helmet / rate limit / lockout / input validation**; CORS wide open by
   default. (Phase 1)
4. **Default seed passwords are in git history** (db/seed.js). Rotate real
   passwords after go-live; add forced password change. (Phase 1)
5. **Monitoring is console.log only**; health check doesn't test the DB. (Phase 6)
6. **No tests** beyond the new smoke script; `npm test` is a placeholder.
7. **Excel source files live in the repo root** and `reportsscreensdevelopment MIS/`
   (~2.5k files incl. binaries). Fine as reference material, but keep new working
   files out (lock files now gitignored).
8. **KPI formulas are hardcoded in page JS** (kpi-data.js, analytics.js) — exactly
   what Phase 3's formula layer replaces.

## Decisions needed from the user (none block Phases 1–2)
- SMTP account for Phase 5/6 alerts (can stub until provided).
- Odoo read-only API credentials + which datasets to pull (Phase 4).
- Go-live server hostname/IP for ALLOWED_ORIGIN and deployment (Phase 7).

---

# OPEN ITEMS GOING INTO GO-LIVE (audit 2026-08-18)

Triggered by a pre-deployment review — surfaced a real architecture
conflict (see `TECHNICAL_SPEC.md` §10/§12) plus concrete app-side gaps.
Closed items were fixed in this pass; the rest are genuinely blocked on
someone outside this repo. Kept in one place so nothing here is silently
forgotten before go-live.

**Closed this pass:**
- [x] Odoo HTTP clients (`odooClient.js`, `odooDispatchClient.js`) had no
      request timeout — a stalled connection could hang a request or the
      daily sync cron indefinitely. Both now abort at 15s. Verified against
      a connection that accepts but never responds (the realistic
      stalled-link failure mode, not just connection-refused).
- [x] Purchases dashboard had no acceptance script —
      `backend/scripts/accept-purchases.js` added, 11/11 passing, modeled
      on `accept-sales.js`'s "must degrade honestly without Odoo" proof.
- [x] Purchases' lack of server-side RBAC was checked against the
      established pattern, not assumed to be a gap: `routes/sales.js`
      itself only role-gates writes, not reads (visibility is
      client-side, same as `routes/insights.js`). Purchases has no writes
      yet, so it already matches convention — no code change needed.
- [x] `purchases.html`'s rendering of the permanently-stubbed category
      grid was checked — it already shows the honest `not_mapped` message
      cleanly rather than a blank/broken section.
- [x] `render.yaml` (dead Render/Vercel preview split, confirmed abandoned
      2026-08-18) removed from the repo.
- [x] `RUNBOOK.md` / `GO_LIVE_CHECKLIST.md` now carry a banner flagging
      them as the superseded on-prem plan, pointing to `TECHNICAL_SPEC.md`
      §10 for current direction.
- [x] `TECHNICAL_SPEC.md` §12 refreshed — all 6 original open questions
      confirmed still unanswered as of 2026-08-18, plus 2 new ones
      (Purchases field names; how a cloud-hosted app reaches on-prem Odoo
      once a platform is chosen).

**Still open — blocked outside this repo:**
- [x] **Odoo team**: hosting platform confirmed 2026-08-19 — DigitalOcean
      droplet, administered by the Odoo team (India), contact GitHub
      `teckzilla007` (`TECHNICAL_SPEC.md` §12 item 6). Deploy guide added:
      `docs/DEPLOYMENT_DIGITALOCEAN.md`, plus `.github/workflows/deploy.yml`
      for auto-deploy-on-push. Still open: no Odoo API credentials issued
      yet (item 1), so the Odoo integration itself stays unblocked-but-idle.
- [ ] **Odoo team**: Purchases category-grid field names ("PO For" /
      "Purchase Type" / "PR No") unconfirmed — `fetchCategoryGrid()`
      stays a stub until answered (§12 item 7).
- [ ] **Whoever picks the hosting platform**: how the app reaches Odoo
      over the network once it's not on the same LAN (§12 item 8) — VPN,
      firewalled endpoint, or shared network. Not resolved by code.
- [ ] Uncommitted working tree as of this audit (`backend/server.js`,
      `forms/api-client.js`, `sidebar.js` modified; Purchases
      routes/services/html new) — ready to commit pending the user's
      go-ahead.

**Pre-existing, lower urgency (carried from earlier audits, not re-verified
in this pass):**
- [ ] Quality KPI formula validated against only 1 day of source data
      (vs. the multi-month validation other KPIs got).
- [ ] "Specific Power Consumption – Up to Clinker" remains a documented
      simplification (direct kWh/clinker-MT, not the full Excel-parity
      build) — see `KPI_REFERENCE.md`.
