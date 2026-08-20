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
  token_version        INTEGER NOT NULL DEFAULT 0      -- bump to revoke all outstanding JWTs
);

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
  UNIQUE (form_type, record_date, shift)        -- one entry per form per date per shift
);

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
  imported_by    INTEGER REFERENCES users(id),
  imported_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
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

-- ── INDEXES (speeds up common queries) ──────────────────────
CREATE INDEX IF NOT EXISTS idx_daily_reports_date     ON daily_reports(record_date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_form     ON daily_reports(form_type);
-- DATE_TRUNC('month', date) is not IMMUTABLE in this Postgres build, so it
-- can't be used directly in an index expression — EXTRACT year/month is.
CREATE INDEX IF NOT EXISTS idx_daily_reports_month    ON daily_reports((EXTRACT(YEAR FROM record_date)), (EXTRACT(MONTH FROM record_date)));
CREATE INDEX IF NOT EXISTS idx_stoppages_date         ON stoppages(record_date);
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
