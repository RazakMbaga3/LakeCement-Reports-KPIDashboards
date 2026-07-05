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

## Phase 2 — Data Layer Migration — ▶ IN PROGRESS (further along than expected)
- [x] forms/api-client.js complete (submitForm / getForm / getFormRange, auth header)
- [x] form-persist.js: server-first save/load, localStorage demoted to offline cache
- [x] report-loader.js: server-first read
- [ ] Verify EVERY form (kiln, cement-mill, cpp, power, limestone, mines, dispatch,
      quality, pile-quality, materials, stoppage) submits to Postgres end-to-end
- [ ] Verify analytics.js / kpi-data.js / index.html read from API
- [ ] Offline queue with sync-on-reconnect (currently: fallback read cache only —
      writes made while offline are NOT queued for replay)
- [ ] One-time localStorage → Postgres import for historical entries
- [ ] Accept: two-browser test with cleared localStorage; kill-server-mid-entry test

## Phase 3 — KPI Formula Layer — ⬜ NOT STARTED
Facts registry + formula registry + audited manual override (design agreed — see
MASTER_BUILD_PROMPT §Phase 3). Schema has `kpi_monthly` but no facts/formula tables.

## Phase 4 — Odoo Integration (read-only) — ⬜ NOT STARTED

## Phase 5 — Reporting & Distribution — ⬜ NOT STARTED
(Report HTML pages exist and render; no server-side PDF/XLSX export, no digest.)

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
