-- 006: Sales department reference + target data.
-- Daily sales projections are NOT here — they're a one-blob-per-day shape
-- and live in daily_reports (form_type='sales-projection'), same as every
-- other daily form. Only the two things daily_reports cannot express get
-- tables here: the territory hierarchy, and monthly targets.

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

-- One table for both interim manual targets and (later) Odoo-sourced ones.
-- `source` is what the dashboard labels the Target tile with, so a manual
-- interim figure can never be mistaken for an ERP figure. A company-wide
-- target uses the sentinel officer_code '_company' rather than NULL,
-- since Postgres treats NULLs as distinct under UNIQUE.
CREATE TABLE IF NOT EXISTS sales_targets (
  id            SERIAL PRIMARY KEY,
  target_month  DATE          NOT NULL,
  officer_code  VARCHAR(30)   REFERENCES sales_territories(officer_code),
  grade_key     VARCHAR(20),                              -- NULL = all-grades total
  target_mt     NUMERIC(12,3) NOT NULL,
  source        VARCHAR(20)   NOT NULL DEFAULT 'manual',   -- 'manual' | 'odoo'
  set_by        INTEGER REFERENCES users(id),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (target_month, officer_code, grade_key)
);

CREATE INDEX IF NOT EXISTS idx_sales_territories_division ON sales_territories(division);
CREATE INDEX IF NOT EXISTS idx_sales_targets_month         ON sales_targets(target_month);
