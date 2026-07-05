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
  last_login   TIMESTAMP
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
  updated_by   INTEGER REFERENCES users(id),
  updated_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (department, year, month, kpi_key)
);

-- ── INDEXES (speeds up common queries) ──────────────────────
CREATE INDEX IF NOT EXISTS idx_daily_reports_date     ON daily_reports(record_date);
CREATE INDEX IF NOT EXISTS idx_daily_reports_form     ON daily_reports(form_type);
-- DATE_TRUNC('month', date) is not IMMUTABLE in this Postgres build, so it
-- can't be used directly in an index expression — EXTRACT year/month is.
CREATE INDEX IF NOT EXISTS idx_daily_reports_month    ON daily_reports((EXTRACT(YEAR FROM record_date)), (EXTRACT(MONTH FROM record_date)));
CREATE INDEX IF NOT EXISTS idx_stoppages_date         ON stoppages(record_date);
CREATE INDEX IF NOT EXISTS idx_kpi_monthly_dept_year  ON kpi_monthly(department, year, month);
CREATE INDEX IF NOT EXISTS idx_audit_log_user         ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_date         ON audit_log(created_at);

-- ============================================================
-- DONE. Tables created.
-- ============================================================
