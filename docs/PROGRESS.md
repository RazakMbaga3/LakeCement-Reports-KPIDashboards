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
- [x] Rate limiting on /api/auth/* (AUTH_RATE_LIMIT/5min) + account lockout
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
- NOTE for formula review with the plant: the ported Specific Thermal
  Energy formula (coal × NCV × 1000 / prod) yields ~600,000 against a
  target of 780 kcal/kg — the ×1000 factor looks unit-inconsistent. It was
  ported verbatim (both old copies had it); fixing it is now a one-line,
  versioned registry change once production confirms the intended units.

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

## Phase 6 — Monitoring & Observability — ⬜ NOT STARTED
Current state: console.log request logging; shallow `/api/health` (no DB check).

## Phase 7 — Deployment, Backup & DR — ⬜ NOT STARTED
Runs via `npm run dev` only. No service, no Nginx, no pg_dump schedule, no runbook.

## Phase 8 — Moat features — ⬜ NOT STARTED

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
