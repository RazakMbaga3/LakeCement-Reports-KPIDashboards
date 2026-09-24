-- 026: remember what each scheduled Odoo pull last did.
--
-- Until now a pull's only trace was a log line, and a FAILED pull's only
-- alert was an email — which is blocked at the tenant (RAID R-6). So "is
-- the mining/dispatch/production pull actually live?" could not be answered
-- from inside the app: /api/health said "pulling on schedule" whenever the
-- URLs were merely set, even with the cron switched off. One row per pull
-- (odooSync.js's PULLS names) turns that into a checkable fact.

CREATE TABLE IF NOT EXISTS odoo_sync_state (
  pull_name        VARCHAR(60) PRIMARY KEY,
  last_run_at      TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ,
  last_result      JSONB
);
