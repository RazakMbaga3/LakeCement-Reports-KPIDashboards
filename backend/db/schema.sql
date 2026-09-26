-- ============================================================
-- Lake Cement Ltd — MIS Database Schema
-- PostgreSQL 15+
-- Run this once to create all tables
-- ============================================================

-- ── USERS ───────────────────────────────────────────────────
-- Stores all system users (replaces the hardcoded array in auth.js)
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  username     VARCHAR(50)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,          -- bcrypt hash, never plain text
  full_name    VARCHAR(100) NOT NULL,
  role         VARCHAR(30)  NOT NULL,
  department   VARCHAR(50),
  active       BOOLEAN      DEFAULT true,
  created_at   TIMESTAMP    DEFAULT NOW(),
  last_login   TIMESTAMP,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,     -- consecutive bad logins
  locked_until         TIMESTAMP,                      -- lockout expiry (NULL = not locked)
  must_change_password BOOLEAN NOT NULL DEFAULT false, -- gate all routes until password set
  token_version        INTEGER NOT NULL DEFAULT 0,     -- bump to revoke all outstanding JWTs
  -- 'officer' | 'senior' | 'hod' (L3 | L2 | L1) — orthogonal to `role`
  -- (role = department). Read by the report-approval gate AND, since
  -- 2026-09-03, by the monthly-KPI write gate: only an HOD may edit KPI
  -- values, while Officer/Senior fill and submit the daily reports that
  -- feed them. See migrations/009_user_levels.sql, middleware/approval.js
  -- and middleware/kpiAccess.js.
  level        VARCHAR(10)  NOT NULL DEFAULT 'hod' CHECK (level IN ('officer','senior','hod')),
  -- Identity + recovery address, NOT the login (username is). NULL for the
  -- AUTOMATION service accounts, which have no mailbox, and for humans not
  -- yet returned by their department. See migrations/012_user_email.sql.
  email          VARCHAR(120),
  phone          VARCHAR(30),
  staff_no       VARCHAR(30),
  email_verified BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT users_email_shape_check
    CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
);

-- Case-insensitive; NULLs excluded so many accounts may sit without a
-- mailbox while two accounts can never share one address.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

-- ── SCHEMA MIGRATIONS ───────────────────────────────────────
-- Tracks applied db/migrations/*.sql files (see db/migrate.js).
-- This schema.sql is always the canonical CURRENT state; migrations
-- upgrade databases created from an older version of it.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ── AUDIT LOG ───────────────────────────────────────────────
-- Every login, data entry, and edit is recorded here
CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  username    VARCHAR(50),
  action      VARCHAR(100) NOT NULL,            -- e.g. 'LOGIN', 'FORM_SUBMIT', 'FORM_EDIT'
  form_type   VARCHAR(50),                      -- e.g. 'production', 'dispatch'
  record_date DATE,                             -- the date the data is for
  details     TEXT,
  ip_address  VARCHAR(45),
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ── DAILY FORM DATA ─────────────────────────────────────────
-- One universal table for all 10 daily forms.
-- "form_type" tells us which form it is.
-- "data" stores the form fields as JSON (flexible — no need to change the table when forms change).
-- "record_date" is the DATE the report covers (not when it was submitted).
CREATE TABLE IF NOT EXISTS daily_reports (
  id            SERIAL PRIMARY KEY,
  form_type     VARCHAR(50)  NOT NULL,          -- 'production','dispatch','quality','power', etc.
  record_date   DATE         NOT NULL,
  shift         VARCHAR(10)  DEFAULT 'day',     -- 'day' | 'night' | 'all'
  data          JSONB        NOT NULL,           -- all form fields stored here
  submitted_by  INTEGER      REFERENCES users(id),
  submitted_at  TIMESTAMP    DEFAULT NOW(),
  updated_by    INTEGER      REFERENCES users(id),
  updated_at    TIMESTAMP,
  -- Real backend-enforced approval workflow (migrations/010_report_approvals.sql).
  -- Officer/Senior submissions land as 'pending_approval'; only their
  -- department's HOD (level='hod') may approve/reject via /api/reports/:formType/:date/{approve,reject}.
  status            VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected')),
  approved_by       INTEGER     REFERENCES users(id),
  approved_at       TIMESTAMP,
  rejected_by       INTEGER     REFERENCES users(id),
  rejected_at       TIMESTAMP,
  rejection_reason  TEXT,
  UNIQUE (form_type, record_date, shift)        -- one entry per form per date per shift
);

-- ── REPORT REVISIONS (append-only history of daily_reports) ─
-- Every PRE-IMAGE of a report that was ever reported: what it held before
-- each change, who changed it and why. audit_log says a change happened;
-- this says what the report used to say, which is the only thing that can
-- answer "what number did the MIS pack quote on Tuesday" after someone
-- edits the day. A full snapshot rather than a diff chain on purpose —
-- see migrations/024_report_revisions.sql for the reasoning.
-- Written by services/reportRevisions.js. NEVER UPDATE OR DELETE a row here.
CREATE TABLE IF NOT EXISTS report_revisions (
  id                 BIGSERIAL PRIMARY KEY,
  form_type          VARCHAR(50)  NOT NULL,
  record_date        DATE         NOT NULL,
  shift              VARCHAR(10)  NOT NULL DEFAULT 'day',
  revision           INTEGER      NOT NULL,     -- 1, 2, 3 … per report
  action             VARCHAR(30)  NOT NULL CHECK (action IN (
                       'FORM_SUBMIT', 'FORM_DRAFT', 'FORM_APPROVE', 'FORM_REJECT',
                       'AMENDMENT_GRANT', 'AMENDMENT_EXPIRE_REVERT',
                       'FORM_AMEND_DIRECT', 'ODOO_AUTOFILL')),
  prior_data         JSONB,                     -- NULL = no report yet, or the action doesn't touch data
  prior_status       VARCHAR(20),
  prior_approved_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  prior_approved_at  TIMESTAMP,
  changed_fields     TEXT[]       NOT NULL DEFAULT '{}',
  amendment_id       INTEGER,                   -- FK added by migration 025 (WS-A2)
  actor_id           INTEGER      REFERENCES users(id) ON DELETE SET NULL,  -- NULL = no human (odoo-sync, cron), or a since-deleted account; actor_name keeps the name
  actor_name         VARCHAR(100),
  reason             TEXT,                      -- rejection reason, or the admin's amendReason
  ip_address         VARCHAR(45),
  created_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (form_type, record_date, shift, revision)
);
CREATE INDEX IF NOT EXISTS idx_report_revisions_report
  ON report_revisions(form_type, record_date, shift, revision DESC);
CREATE INDEX IF NOT EXISTS idx_report_revisions_created
  ON report_revisions(created_at DESC);

-- ── REPORT AMENDMENTS ───────────────────────────────────────
-- Correction requests against a report that has already been reported. A
-- grant opens a time-boxed write window; daily_reports.status is NOT changed,
-- so the day keeps counting in every KPI while a correction is open. See
-- migrations/027_report_amendments.sql for the reasoning.
CREATE TABLE IF NOT EXISTS report_amendments (
  id                   SERIAL       PRIMARY KEY,
  form_type            VARCHAR(50)  NOT NULL,
  record_date          DATE         NOT NULL,
  shift                VARCHAR(10)  NOT NULL DEFAULT 'day',
  status               VARCHAR(20)  NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','granted','applied','declined','withdrawn','expired')),
  reason               TEXT         NOT NULL,
  fields_flagged       TEXT[]       NOT NULL DEFAULT '{}',
  requested_by         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name    VARCHAR(100),
  requested_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  locked_status        VARCHAR(20),
  decided_by           INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name      VARCHAR(100),
  decided_at           TIMESTAMP,
  decision_note        TEXT,
  baseline_revision_id BIGINT       REFERENCES report_revisions(id) ON DELETE SET NULL,
  expires_at           TIMESTAMP,
  applied_at           TIMESTAMP,
  applied_revision_id  BIGINT       REFERENCES report_revisions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_amendments_open
  ON report_amendments(form_type, record_date, shift)
  WHERE status IN ('requested','granted');
CREATE INDEX IF NOT EXISTS idx_report_amendments_open
  ON report_amendments(status, requested_at)
  WHERE status IN ('requested','granted');
CREATE INDEX IF NOT EXISTS idx_report_amendments_day
  ON report_amendments(form_type, record_date, shift);
CREATE INDEX IF NOT EXISTS idx_report_amendments_requester
  ON report_amendments(requested_by, requested_at DESC);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_revisions_amendment_fk') THEN
    ALTER TABLE report_revisions
      ADD CONSTRAINT report_revisions_amendment_fk
      FOREIGN KEY (amendment_id) REFERENCES report_amendments(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── STOPPAGES ───────────────────────────────────────────────
-- Separate table because stoppages are multi-row per day (multiple events)
CREATE TABLE IF NOT EXISTS stoppages (
  id              SERIAL PRIMARY KEY,
  record_date     DATE        NOT NULL,
  equipment       VARCHAR(100),
  department      VARCHAR(50),
  start_time      TIME,
  end_time        TIME,
  duration_hours  NUMERIC(5,2),
  reason          TEXT,
  category        VARCHAR(50),                  -- 'planned' | 'unplanned' | 'breakdown'
  submitted_by    INTEGER REFERENCES users(id),
  submitted_at    TIMESTAMP DEFAULT NOW()
);

-- ── STOPPAGE FACTS (granular, from the monthly workbook) ────
-- Additive alongside `daily_reports` form_type='stoppage' (the coarse
-- shift/day stop_<equip>_<cause> MINUTES matrix, still live for Apr-Jun
-- 2026 and beyond). This table holds one row per named fault, per
-- equipment, per cause bucket, per calendar day, in HOURS — imported from
-- the plant's monthly "Stoppage report" Excel workbooks (see
-- scripts/import-stoppage-facts.js; migrations/011_stoppage_facts.sql).
-- Not a replacement for the `stoppages` table above (that one has never
-- been wired to any route or script) or for daily_reports — services/
-- insights.js falls back to the coarse source for any date a given
-- equipment has no rows here.
CREATE TABLE IF NOT EXISTS stoppage_facts (
  id                 SERIAL PRIMARY KEY,
  equipment          VARCHAR(20)   NOT NULL,
  cause              VARCHAR(20)   NOT NULL,
  fault_description  VARCHAR(300)  NOT NULL,
  record_date        DATE          NOT NULL,
  hours              NUMERIC(6,2)  NOT NULL CHECK (hours > 0),
  source_file        VARCHAR(200),
  imported_by        INTEGER REFERENCES users(id),
  imported_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  UNIQUE (equipment, cause, fault_description, record_date)
);

-- ── STOPPAGE REASON CATALOGUE ───────────────────────────────
-- The governed vocabulary the stoppage entry form offers instead of a free
-- text box, so the same fault can't arrive spelled a dozen different ways.
-- Mirrors the fixed, pre-printed fault list in the plant's own monthly
-- "Stoppage report" workbook: one row per named fault, grouped by cause,
-- and the shift only fills in hours against the line that happened.
-- `label` pairs with stoppage_facts.fault_description (same VARCHAR(300)).
-- Seeded with the workbook's 417 rows by migrations/017.
CREATE TABLE IF NOT EXISTS stoppage_reasons (
  id          SERIAL PRIMARY KEY,
  equipment   VARCHAR(20)  NOT NULL,
  cause       VARCHAR(20)  NOT NULL,
  label       VARCHAR(300) NOT NULL,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id),  -- NULL = seeded from the workbook
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (equipment, cause, label)
);

-- ── WEIGHBRIDGE TICKETS (Quarry) ────────────────────────────
-- Odoo weighbridge ticket log ("Uploaded_Data" export). Many rows per
-- day, deduped by ticket_no — same shape as `stoppages`, so it gets its
-- own table rather than the generic one-blob-per-day `daily_reports`.
CREATE TABLE IF NOT EXISTS weighbridge_tickets (
  id             SERIAL PRIMARY KEY,
  ticket_no      VARCHAR(50)  UNIQUE NOT NULL,
  vendor         VARCHAR(150),
  vehicle        VARCHAR(50),
  transfer_type  VARCHAR(30),            -- raw Odoo value: 'Production' | 'Internal'
  movement_type  VARCHAR(120) NOT NULL,  -- e.g. 'South Mine to Pile (through Crusher)'
  product        VARCHAR(50)  NOT NULL,  -- 'HG','LG1','OB/CLAY','LIMESTONE SPG', etc.
  ticket_date    DATE         NOT NULL,
  net_qty        NUMERIC(10,3) NOT NULL,
  gross_datetime VARCHAR(40),            -- raw exported timestamp, informational only
  source         VARCHAR(12)  NOT NULL DEFAULT 'excel',  -- 'excel' (manual upload) | 'odoo' (mining_report sync)
  imported_by    INTEGER REFERENCES users(id),           -- NULL for API-sourced rows: no human imported them
  imported_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_weighbridge_source_date ON weighbridge_tickets(source, ticket_date);

-- ── ODOO PRODUCTION ENTRIES ─────────────────────────────────
-- Mirror of Odoo's production_report: one row per production run, keyed by
-- Odoo's own unique reference. The daily production report's facts are
-- derived from these rows (services/odooProductionMapper.js). The endpoint
-- has no approval status or timestamps, so content_hash/revision record an
-- amended entry and withdrawn_at records one that vanished. See migration 018.
CREATE TABLE IF NOT EXISTS odoo_production_entries (
  entry_ref        VARCHAR(40)   PRIMARY KEY,   -- Odoo reference, e.g. CEM/2026/02168
  production_date  DATE          NOT NULL,
  picking_type     VARCHAR(80)   NOT NULL,      -- verbatim, e.g. 'CEMENT: Clinker Production'
  stage            VARCHAR(12),                 -- raw_meal|clinker|fine_coal|cm1|cm2; NULL = unmapped picking type
  product_code     VARCHAR(30),
  product_name     TEXT,
  uom              VARCHAR(10),
  produced_qty     NUMERIC(14,3) NOT NULL,
  total_input_qty  NUMERIC(14,3),
  consumed_items   JSONB         NOT NULL DEFAULT '[]'::jsonb,
  content_hash     CHAR(16)      NOT NULL,
  revision         INTEGER       NOT NULL DEFAULT 1,
  first_seen_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP,
  withdrawn_at     TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_odoo_prod_entries_date_stage ON odoo_production_entries(production_date, stage);

-- ── ODOO SYNC STATE ─────────────────────────────────────────
-- What each scheduled Odoo pull last did (migration 026) — the only way to
-- tell from inside the app whether a pull is actually live.
CREATE TABLE IF NOT EXISTS odoo_sync_state (
  pull_name        VARCHAR(60) PRIMARY KEY,
  last_run_at      TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_error       TEXT,
  last_error_at    TIMESTAMPTZ,
  last_result      JSONB
);

-- ── KPI MONTHLY ─────────────────────────────────────────────
-- Stores manually entered or auto-calculated monthly KPI targets and actuals
CREATE TABLE IF NOT EXISTS kpi_monthly (
  id           SERIAL PRIMARY KEY,
  department   VARCHAR(50)  NOT NULL,
  year         SMALLINT     NOT NULL,
  month        SMALLINT     NOT NULL CHECK (month BETWEEN 1 AND 12),
  kpi_key      VARCHAR(100) NOT NULL,           -- e.g. 'clinker_production', 'dispatch_total'
  target       NUMERIC(12,3),
  actual       NUMERIC(12,3),
  unit         VARCHAR(20),                     -- 'MT', 'kWh', '%', etc.
  remarks      TEXT,
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (department, year, month, kpi_key)
);

-- ── KPI OVERRIDES ───────────────────────────────────────────
-- Audited manual overrides of formula-computed KPI values (see
-- forms/formula-registry.js + backend/services/formulaEngine.js).
-- Rows are permanent: cleared/superseded, never deleted.
CREATE TABLE IF NOT EXISTS kpi_overrides (
  id              SERIAL PRIMARY KEY,
  kpi_key         VARCHAR(100)  NOT NULL,
  year            SMALLINT      NOT NULL,
  month           SMALLINT      NOT NULL CHECK (month BETWEEN 1 AND 12),
  value_override  NUMERIC(14,4) NOT NULL,
  value_computed  NUMERIC(14,4),            -- what the formula said at override time
  reason          TEXT          NOT NULL,
  created_by      INTEGER REFERENCES users(id),
  created_by_name VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  cleared_at      TIMESTAMP,
  cleared_by      INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_kpi_overrides_period ON kpi_overrides(kpi_key, year, month);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_overrides_active
  ON kpi_overrides(kpi_key, year, month) WHERE cleared_at IS NULL;

-- ── CLIENT ERRORS ───────────────────────────────────────────
-- Browser error reports from plant-floor pages (see routes/monitor.js);
-- 60-day retention enforced on insert.
CREATE TABLE IF NOT EXISTS client_errors (
  id         SERIAL PRIMARY KEY,
  username   VARCHAR(50),
  page       VARCHAR(120),
  message    VARCHAR(500) NOT NULL,
  source     VARCHAR(300),
  line       INTEGER,
  stack      VARCHAR(2000),
  user_agent VARCHAR(300),
  ip_address VARCHAR(45),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_errors_date ON client_errors(created_at);

-- ── ALERTS ──────────────────────────────────────────────────
-- Operational alerts fired by the watchdog (services/watchdog.js);
-- also its once-per-day dedupe store.
CREATE TABLE IF NOT EXISTS alerts (
  id         SERIAL PRIMARY KEY,
  kind       VARCHAR(80)  NOT NULL,
  detail     TEXT,
  emailed    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_kind_date ON alerts(kind, created_at);

-- ── SALES TERRITORIES ───────────────────────────────────────
-- One clean Division -> Zone -> Sales Officer hierarchy (replacing the
-- standalone sales app's three separate, inconsistent versions of this).
-- officer_code is a stable slug used as a daily_reports JSONB key prefix,
-- so it must never change even if the display name is corrected.
CREATE TABLE IF NOT EXISTS sales_territories (
  id                 SERIAL PRIMARY KEY,
  officer_code       VARCHAR(30)  UNIQUE NOT NULL,
  sales_officer      VARCHAR(120) NOT NULL,
  zone               VARCHAR(80)  NOT NULL,
  division           VARCHAR(80)  NOT NULL,
  divisional_manager VARCHAR(120),
  -- Odoo seam: NULL until `npm run odoo:test -- res.partner --sample`
  -- confirms the real x_studio_zone/x_studio_division tag values. Nothing
  -- depends on these yet — filled in once Phase B exploration happens.
  odoo_zone_tag      VARCHAR(120),
  odoo_division_tag  VARCHAR(120),
  odoo_user_id       INTEGER,
  active             BOOLEAN NOT NULL DEFAULT true,
  sort_order         SMALLINT NOT NULL DEFAULT 100,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (zone, division)
);

-- ── SALES TARGETS ───────────────────────────────────────────
-- One table for both interim manual targets and (later) Odoo-sourced ones.
-- `source` is what the dashboard labels the Target tile with, so a manual
-- interim figure can never be mistaken for an ERP figure. A company-wide
-- target uses the sentinel officer_code '_company' rather than NULL,
-- since Postgres treats NULLs as distinct under UNIQUE.
-- officer_code is deliberately NOT a foreign key to sales_territories — a
-- DB FK can't express "this column is either '_company' or a valid FK",
-- so that check lives at the application layer instead (see
-- backend/routes/sales.js's POST /targets). An FK here would make the
-- '_company' sentinel impossible to insert (see migration 007's header).
CREATE TABLE IF NOT EXISTS sales_targets (
  id            SERIAL PRIMARY KEY,
  target_month  DATE          NOT NULL,
  officer_code  VARCHAR(30),
  grade_key     VARCHAR(20)   NOT NULL DEFAULT '_all',     -- '_all' = all-grades total (sentinel, not NULL — see migration 008)
  target_mt     NUMERIC(12,3) NOT NULL,
  source        VARCHAR(20)   NOT NULL DEFAULT 'manual',   -- 'manual' | 'odoo'
  set_by        INTEGER REFERENCES users(id),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (target_month, officer_code, grade_key)
);

-- Fixed Specific Power targets for the Power Consumption Report's Section 1
-- table — see migration 022's header for why these live here instead of a
-- plain HTML input. One row per section, no month/year dimension: the
-- figure is a roughly-yearly engineering constant, changed deliberately and
-- rarely rather than tracked per period.
CREATE TABLE IF NOT EXISTS power_targets (
  section       VARCHAR(20)  PRIMARY KEY,   -- crusher|rawmill|coalmill|kiln|cm1|cm2|packing|utilities
  target_kwh_mt NUMERIC(8,2) NOT NULL,
  updated_by    INTEGER REFERENCES users(id),
  updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ── INDEXES (speeds up common queries) ──────────────────────
CREATE INDEX IF NOT EXISTS idx_daily_reports_date     ON daily_reports(record_date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_form     ON daily_reports(form_type);
-- DATE_TRUNC('month', date) is not IMMUTABLE in this Postgres build, so it
-- can't be used directly in an index expression — EXTRACT year/month is.
CREATE INDEX IF NOT EXISTS idx_daily_reports_month    ON daily_reports((EXTRACT(YEAR FROM record_date)), (EXTRACT(MONTH FROM record_date)));
CREATE INDEX IF NOT EXISTS idx_daily_reports_status   ON daily_reports(status);
CREATE INDEX IF NOT EXISTS idx_stoppages_date         ON stoppages(record_date);
CREATE INDEX IF NOT EXISTS idx_stoppage_facts_date        ON stoppage_facts(record_date);
CREATE INDEX IF NOT EXISTS idx_stoppage_facts_equip_date  ON stoppage_facts(equipment, record_date);
CREATE INDEX IF NOT EXISTS idx_stoppage_facts_month ON stoppage_facts(
  equipment, (EXTRACT(YEAR FROM record_date)), (EXTRACT(MONTH FROM record_date)));
CREATE INDEX IF NOT EXISTS idx_stoppage_reasons_equip     ON stoppage_reasons(equipment, cause, sort_order);
CREATE INDEX IF NOT EXISTS idx_weighbridge_date       ON weighbridge_tickets(ticket_date);
CREATE INDEX IF NOT EXISTS idx_weighbridge_movement   ON weighbridge_tickets(movement_type);
CREATE INDEX IF NOT EXISTS idx_kpi_monthly_dept_year  ON kpi_monthly(department, year, month);
CREATE INDEX IF NOT EXISTS idx_audit_log_user         ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_date         ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_territories_division ON sales_territories(division);
CREATE INDEX IF NOT EXISTS idx_sales_targets_month         ON sales_targets(target_month);

-- ============================================================
-- DONE. Tables created.
-- ============================================================
