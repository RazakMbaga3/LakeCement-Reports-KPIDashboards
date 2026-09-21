-- 018: mirror of Odoo's production_report entries.
--
-- The endpoint (services/odooProductionClient.js, delivered 2026-09-20 on the
-- production ERP) returns one entry per production run: a reference, a date,
-- a product, the quantity produced and the materials consumed. The daily
-- production report (daily-report.html) is those same runs re-typed by hand,
-- so this table holds them as Odoo sent them and the report's facts are
-- derived from it (services/odooProductionMapper.js), never the other way.
--
-- entry_ref is Odoo's own reference (CEM/2026/02168, CLK/2026/00164 …). It is
-- unique across all 8,730 entries pulled so far, which is what lets this be a
-- plain upsert; the mining mirror had to invent a key because its endpoint has
-- none.
--
-- The endpoint returns no approval status and no timestamps, so two columns
-- carry what it cannot:
--   content_hash / revision / updated_at  — an entry whose content changed in
--       Odoo is rewritten and its revision counted, so an amended day is
--       visible instead of silent.
--   last_seen_at / withdrawn_at            — an entry that stops appearing
--       (deleted, or sent back to draft in Odoo) is marked withdrawn rather
--       than deleted. Readers ignore withdrawn rows; the history stays.
--
-- stage is NULL for a picking type the mapping does not know. Those rows are
-- stored anyway and reported, so a new Odoo production line is visible the day
-- it appears.
CREATE TABLE IF NOT EXISTS odoo_production_entries (
  entry_ref        VARCHAR(40)   PRIMARY KEY,
  production_date  DATE          NOT NULL,
  picking_type     VARCHAR(80)   NOT NULL,
  stage            VARCHAR(12),
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

-- The two hot paths: "everything for this day" (a report load) and "which
-- live entries in this window were not in the latest pull" (the sweep).
CREATE INDEX IF NOT EXISTS idx_odoo_prod_entries_date_stage
  ON odoo_production_entries(production_date, stage);
