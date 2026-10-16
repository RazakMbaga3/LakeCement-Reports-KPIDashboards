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
                       'FORM_AMEND_DIRECT', 'ODOO_AUTOFILL',
                       'POWER_AUTOFILL')),            -- migration 045, services/powerToProduction.js
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

-- ── PRODUCTION ← POWER CONSUMPTION COPY ─────────────────────
-- Per day and per spc_*_kwh field of the Production report: did
-- services/powerToProduction.js write the value now there ('copied'), or does
-- the report hold a different human-entered figure ('conflict')? The current
-- picture only — the write history is in report_revisions (POWER_AUTOFILL).
-- See migrations/045_production_power_copy.sql for the reasoning.
CREATE TABLE IF NOT EXISTS production_power_copy (
  record_date      DATE          NOT NULL,
  shift            VARCHAR(10)   NOT NULL DEFAULT 'day',
  field            VARCHAR(50)   NOT NULL,
  state            VARCHAR(10)   NOT NULL CHECK (state IN ('copied', 'conflict')),
  power_value      NUMERIC(14,2),
  production_value NUMERIC(14,2),
  copied_value     NUMERIC(14,2),
  power_status     VARCHAR(20),
  state_since      TIMESTAMP     NOT NULL DEFAULT NOW(),
  checked_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
  PRIMARY KEY (record_date, shift, field)
);
CREATE INDEX IF NOT EXISTS idx_production_power_copy_state ON production_power_copy(state, record_date);

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

-- ── IT ASSET REGISTER ───────────────────────────────────────
-- One polymorphic table for all 10 IT asset registers (computers,
-- printers, licenses, CCTV, network gear, etc.) — category + JSONB data,
-- same "many shapes, one lifecycle" choice as daily_reports' form_type +
-- data. it_asset_imports is the audit trail for the whole-category
-- replace-on-import an upload performs. See
-- migrations/028_it_assets.sql for the full reasoning.
CREATE TABLE IF NOT EXISTS it_assets (
  id              SERIAL       PRIMARY KEY,
  category        VARCHAR(30)  NOT NULL
    CHECK (category IN (
      'factory_computers', 'ho_computers', 'printers', 'equipment_software',
      'dcs_licenses', 'network_switches', 'cctv', 'external_hard_disks',
      'biometric_devices', 'ewaste'
    )),
  data            JSONB        NOT NULL DEFAULT '{}',
  source          VARCHAR(10)  NOT NULL DEFAULT 'manual'
    CHECK (source IN ('import', 'manual')),
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_by      INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS idx_it_assets_category ON it_assets (category);
CREATE INDEX IF NOT EXISTS idx_it_assets_data_gin ON it_assets USING GIN (data);

CREATE TABLE IF NOT EXISTS it_asset_imports (
  id                  SERIAL       PRIMARY KEY,
  category            VARCHAR(30)  NOT NULL,
  imported_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  imported_by         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  imported_by_name    VARCHAR(100),
  source_filename     VARCHAR(255),
  row_count           INTEGER      NOT NULL,
  previous_row_count  INTEGER      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_it_asset_imports_category ON it_asset_imports (category, imported_at DESC);

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

-- ── COMPLIANCE MASTER ────────────────────────────────────────
-- Mirror of migrations/037_compliance_register.sql and
-- 038_compliance_documents_reminders.sql — see them for the reasoning
-- (status is computed, never stored; documents live in Postgres).
CREATE TABLE IF NOT EXISTS compliance_contacts (
  id               SERIAL       PRIMARY KEY,
  name             VARCHAR(100) NOT NULL,
  email            VARCHAR(120)
    CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  user_id          INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  aliases          TEXT[]       NOT NULL DEFAULT '{}',
  active           BOOLEAN      NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by       INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name  VARCHAR(100)
);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_contacts_name_uniq ON compliance_contacts (LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS compliance_contacts_user_uniq ON compliance_contacts (user_id) WHERE user_id IS NOT NULL;

-- ── Groups: a mining licence and its obligations, or a bundle (ISO set) ──
CREATE TABLE IF NOT EXISTS compliance_groups (
  id          SERIAL       PRIMARY KEY,
  kind        VARCHAR(20)  NOT NULL CHECK (kind IN ('mining_licence','bundle')),
  code        VARCHAR(60)  NOT NULL,
  title       VARCHAR(200),
  owner_role  VARCHAR(30)  NOT NULL,
  entity      VARCHAR(10)  NOT NULL DEFAULT 'LCL',
  attrs       JSONB        NOT NULL DEFAULT '{}',   -- location, licence type, resource, area: display only
  import_key  VARCHAR(80)  UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (kind, code)
);

-- ── The obligations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_items (
  id                     SERIAL        PRIMARY KEY,
  kind                   VARCHAR(10)   NOT NULL CHECK (kind IN ('validity','recurring','condition')),
  owner_role             VARCHAR(30)   NOT NULL CHECK (owner_role ~ '^[a-z]+$'),
  section_label          VARCHAR(60),
  entity                 VARCHAR(10)   NOT NULL DEFAULT 'LCL' CHECK (entity IN ('LCL','BRL','UCL')),
  group_id               INTEGER       REFERENCES compliance_groups(id) ON DELETE SET NULL,
  title                  VARCHAR(200)  NOT NULL,
  description            TEXT,
  agency                 VARCHAR(200),
  reference_no           VARCHAR(100),
  custodian              VARCHAR(30),
  criticality            VARCHAR(8)    NOT NULL DEFAULT 'normal' CHECK (criticality IN ('high','normal','low')),
  frequency_label        VARCHAR(120),

  -- validity
  valid_from             DATE,
  valid_to               DATE,
  no_expiry              BOOLEAN       NOT NULL DEFAULT false,

  -- recurrence (kind = 'recurring')
  rec_unit               VARCHAR(10)   CHECK (rec_unit IN ('month','quarter','half','year','years','on_demand')),
  rec_interval           SMALLINT      NOT NULL DEFAULT 1 CHECK (rec_interval BETWEEN 1 AND 20),
  rec_due_day            SMALLINT      CHECK (rec_due_day BETWEEN 1 AND 31),
  rec_due_month          SMALLINT      CHECK (rec_due_month BETWEEN 1 AND 12),
  rec_anchor_date        DATE,
  track_from             DATE,

  -- condition
  review_interval_months SMALLINT      CHECK (review_interval_months BETWEEN 1 AND 120),
  next_review_on         DATE,
  condition_result       VARCHAR(14)   CHECK (condition_result IN ('complied','partial','not_complied','not_applicable')),
  condition_assessed_on  DATE,

  -- reminders (NULL = the kind's default, from compliance_settings)
  lead_days_1            SMALLINT      CHECK (lead_days_1 BETWEEN 0 AND 365),
  lead_days_2            SMALLINT      CHECK (lead_days_2 BETWEEN 0 AND 365),
  lead_days_3            SMALLINT      CHECK (lead_days_3 BETWEEN 0 AND 365),
  reminders_enabled      BOOLEAN       NOT NULL DEFAULT true,

  -- lifecycle and secondary flags (flags never change the computed status)
  lifecycle              VARCHAR(10)   NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','inactive','archived')),
  inactive_reason        TEXT,
  renewal_in_progress    BOOLEAN       NOT NULL DEFAULT false,
  renewal_note           TEXT,
  renewal_started_on     DATE,
  next_due_on            DATE,          -- maintained by the service; an index, never the truth

  verified_at            TIMESTAMPTZ,
  verified_by            INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  verified_by_name       VARCHAR(100),

  source                 VARCHAR(10)   NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
  import_key             VARCHAR(80),
  source_sheet           VARCHAR(60),
  source_row             INTEGER,
  source_raw             JSONB,         -- the workbook cells as found: the "Sheet said" view
  user_edited_at         TIMESTAMPTZ,   -- set by any in-app edit; re-import never overwrites such a row

  fee_amount             NUMERIC(18,2),
  fee_currency           CHAR(3),
  remarks                TEXT,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by             INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  created_by_name        VARCHAR(100),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by             INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name        VARCHAR(100),

  CHECK (lead_days_1 IS NULL OR lead_days_2 IS NULL OR lead_days_1 >= lead_days_2),
  CHECK (lead_days_2 IS NULL OR lead_days_3 IS NULL OR lead_days_2 >= lead_days_3),
  CHECK (NOT no_expiry OR valid_to IS NULL),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from),
  CHECK (kind <> 'recurring' OR rec_unit IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS compliance_items_import_key_uniq ON compliance_items (import_key) WHERE import_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_compliance_items_owner   ON compliance_items (owner_role);
CREATE INDEX IF NOT EXISTS idx_compliance_items_due     ON compliance_items (next_due_on) WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS idx_compliance_items_group   ON compliance_items (group_id);

-- Responsible person (tier 1, "Level 1" in the workbook) and supervisor
-- (tier 2, "Level 2"). Several per tier: the workbook writes "Muneesh/ Rahul".
CREATE TABLE IF NOT EXISTS compliance_item_responsibles (
  item_id     INTEGER  NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  tier        SMALLINT NOT NULL CHECK (tier IN (1,2)),
  contact_id  INTEGER  NOT NULL REFERENCES compliance_contacts(id) ON DELETE RESTRICT,
  position    SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, tier, contact_id)
);

-- One instance of a recurring obligation. A missed period stays 'open', so
-- the item stays Overdue until that period is done or waived — a later
-- period being generated never hides it.
CREATE TABLE IF NOT EXISTS compliance_periods (
  id             SERIAL        PRIMARY KEY,
  item_id        INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  period_key     VARCHAR(12)   NOT NULL,    -- '2026-10', '2026-Q4', '2026-H2', '2026', 'adhoc-n'
  due_on         DATE          NOT NULL,
  status         VARCHAR(8)    NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','waived')),
  done_on        DATE,
  done_by        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  done_by_name   VARCHAR(100),
  reference      VARCHAR(100),
  amount         NUMERIC(18,2),
  currency       CHAR(3),
  note           TEXT,
  waived_reason  TEXT,
  source         VARCHAR(10)   NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','import','manual')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, period_key),
  CHECK (status <> 'done' OR done_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_compliance_periods_open ON compliance_periods (item_id, due_on) WHERE status = 'open';

-- Append-only judgements on a condition item. assessed_on is unknown only
-- for what the workbook said (source 'import').
CREATE TABLE IF NOT EXISTS compliance_assessments (
  id                SERIAL        PRIMARY KEY,
  item_id           INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  assessed_on       DATE,
  result            VARCHAR(14)   NOT NULL CHECK (result IN ('complied','partial','not_complied','not_applicable')),
  note              TEXT,
  raw_text          VARCHAR(200),
  source            VARCHAR(10)   NOT NULL DEFAULT 'manual' CHECK (source IN ('import','manual')),
  assessed_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  assessed_by_name  VARCHAR(100),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (source = 'import' OR assessed_on IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_compliance_assessments_item ON compliance_assessments (item_id, created_at DESC);

-- What changed on an item, by whom — the record's own History tab.
CREATE TABLE IF NOT EXISTS compliance_history (
  id          BIGSERIAL     PRIMARY KEY,
  item_id     INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  actor_id    INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  actor_name  VARCHAR(100),
  action      VARCHAR(30)   NOT NULL,
  changes     JSONB,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_history_item ON compliance_history (item_id, at DESC);

CREATE TABLE IF NOT EXISTS compliance_imports (
  id           SERIAL        PRIMARY KEY,
  at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  by_id        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  by_name      VARCHAR(100),
  file_name    VARCHAR(255),
  file_sha256  CHAR(64),
  counts       JSONB,
  mapping      JSONB,
  warnings     JSONB
);

-- Key/value settings. reminders_enabled starts FALSE: deploying the module
-- sends nothing until someone with the authority switches it on.
CREATE TABLE IF NOT EXISTS compliance_settings (
  key              VARCHAR(60)   PRIMARY KEY,
  value            JSONB         NOT NULL,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name  VARCHAR(100)
);
INSERT INTO compliance_settings (key, value) VALUES ('reminders_enabled', 'false')
ON CONFLICT (key) DO NOTHING;

-- The central "Head" escalation list (one list for every department).
CREATE TABLE IF NOT EXISTS compliance_head_recipients (
  contact_id  INTEGER      PRIMARY KEY REFERENCES compliance_contacts(id) ON DELETE CASCADE,
  label       VARCHAR(60)  NOT NULL,
  position    SMALLINT     NOT NULL DEFAULT 0
);

-- One row per owning department per day, written by the daily job: the
-- trend line, the KPI month-end figure and the adoption metrics read this.
CREATE TABLE IF NOT EXISTS compliance_snapshots (
  as_of       DATE         NOT NULL,
  owner_role  VARCHAR(30)  NOT NULL,
  active      INTEGER      NOT NULL DEFAULT 0,
  due         INTEGER      NOT NULL DEFAULT 0,
  overdue     INTEGER      NOT NULL DEFAULT 0,
  undated     INTEGER      NOT NULL DEFAULT 0,
  inactive    INTEGER      NOT NULL DEFAULT 0,
  verified    INTEGER      NOT NULL DEFAULT 0,
  total       INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (as_of, owner_role)
);

CREATE TABLE IF NOT EXISTS compliance_blobs (
  sha256      CHAR(64)     PRIMARY KEY,
  size_bytes  INTEGER      NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  bytes       BYTEA        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
-- PDFs and JPEGs are already compressed; EXTERNAL skips a pointless second
-- compression and makes substring() chunk reads cheap for streaming.
ALTER TABLE compliance_blobs ALTER COLUMN bytes SET STORAGE EXTERNAL;

-- Every upload is a new version; nothing is ever overwritten or deleted.
-- A mistaken upload is retracted (kept, marked, reason recorded).
CREATE TABLE IF NOT EXISTS compliance_documents (
  id                 SERIAL        PRIMARY KEY,
  item_id            INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE RESTRICT,
  period_id          INTEGER       REFERENCES compliance_periods(id) ON DELETE SET NULL,
  assessment_id      INTEGER       REFERENCES compliance_assessments(id) ON DELETE SET NULL,
  version_no         INTEGER       NOT NULL CHECK (version_no >= 1),
  doc_type           VARCHAR(12)   NOT NULL DEFAULT 'certificate'
    CHECK (doc_type IN ('certificate','receipt','application','evidence','other')),
  file_name          VARCHAR(255)  NOT NULL,
  mime_type          VARCHAR(100)  NOT NULL,
  size_bytes         INTEGER       NOT NULL,
  blob_sha256        CHAR(64)      NOT NULL REFERENCES compliance_blobs(sha256) ON DELETE RESTRICT,
  valid_from         DATE,
  valid_to           DATE,
  reference_no       VARCHAR(100),
  note               TEXT,
  uploaded_by        INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_name   VARCHAR(100)  NOT NULL,
  uploaded_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  retracted_at       TIMESTAMPTZ,
  retracted_by       INTEGER       REFERENCES users(id) ON DELETE SET NULL,
  retracted_by_name  VARCHAR(100),
  retracted_reason   TEXT
);
-- Version numbers are per item (period evidence shares the item's sequence).
CREATE UNIQUE INDEX IF NOT EXISTS compliance_documents_version_uniq ON compliance_documents (item_id, version_no);
CREATE INDEX IF NOT EXISTS idx_compliance_documents_item ON compliance_documents (item_id, uploaded_at DESC);

-- ── Reminder job ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compliance_reminder_runs (
  id             SERIAL        PRIMARY KEY,
  started_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  as_of          DATE          NOT NULL,
  trigger        VARCHAR(8)    NOT NULL CHECK (trigger IN ('cron','manual')),
  dry_run        BOOLEAN       NOT NULL DEFAULT false,
  ok             BOOLEAN,
  error          VARCHAR(500),
  stats          JSONB,
  duration_ms    INTEGER,
  heap_delta_kb  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_compliance_runs_started ON compliance_reminder_runs (started_at DESC);

-- One row per email actually attempted (a consolidated email covers many
-- notification rows).
CREATE TABLE IF NOT EXISTS compliance_mail_log (
  id               BIGSERIAL     PRIMARY KEY,
  run_id           INTEGER       REFERENCES compliance_reminder_runs(id) ON DELETE SET NULL,
  recipient_email  VARCHAR(120)  NOT NULL,
  subject          VARCHAR(250),
  item_count       INTEGER       NOT NULL DEFAULT 1,
  sent             BOOLEAN       NOT NULL,
  reason           VARCHAR(200),
  transport        VARCHAR(8),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- The outbox. One row per (item, deadline, stage, recipient): the UNIQUE key
-- is what makes a reminder fire exactly once however often the job runs.
-- Rows that cannot go out yet are kept with the reason (held while the
-- record is unverified, no email for the person, reminders switched off), so
-- the app can show who WOULD have been told — and a later run releases them
-- once the reason is gone.
CREATE TABLE IF NOT EXISTS compliance_notifications (
  id               BIGSERIAL     PRIMARY KEY,
  item_id          INTEGER       NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  deadline         DATE          NOT NULL,
  stage            VARCHAR(6)    NOT NULL,    -- 'D', 'S', 'H', 'OD0', 'OD1', …
  audience         VARCHAR(8)    NOT NULL CHECK (audience IN ('direct','second','head')),
  recipient_key    VARCHAR(20)   NOT NULL,    -- 'c:<contactId>' or 'u:<userId>' (HOD fallback)
  recipient_name   VARCHAR(100),
  recipient_email  VARCHAR(120),
  status           VARCHAR(18)   NOT NULL CHECK (status IN ('pending','sent','failed','gave_up','held_unverified',
                                                           'skipped_no_email','skipped_disabled','superseded')),
  attempts         SMALLINT      NOT NULL DEFAULT 0,
  last_error       VARCHAR(200),
  next_attempt_at  TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,
  mail_log_id      BIGINT        REFERENCES compliance_mail_log(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, deadline, stage, recipient_key)
);
CREATE INDEX IF NOT EXISTS idx_compliance_notifications_status ON compliance_notifications (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_compliance_notifications_item   ON compliance_notifications (item_id, created_at DESC);

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
