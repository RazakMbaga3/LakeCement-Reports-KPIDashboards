-- 043: the Production Report stock ledger rolled forward from Odoo
--      (services/odooStockLedger.js, config/odooStockLedger.js).
--
-- Three tables, all written only by that service:
--
--   odoo_stock_ledger      one row per (day, ledger): the computed opening,
--                          flows and closing, whether the day is settled in
--                          Odoo, and — when the closing is withheld — WHY, in
--                          words an officer can act on. It is also the record
--                          of exactly which daily_reports fields the robot
--                          wrote (`written`), which is how a later run tells
--                          its own value (safe to correct) from a figure a
--                          person typed over it (never overwritten).
--
--   odoo_stock_onhand      Odoo's live on-hand per product/scope, taken every
--                          run. History, not a cache: it is what lets anyone
--                          check, after the fact, what Odoo said the stock was
--                          when the ledger was compared with it.
--
--   odoo_stock_ledger_runs one row per run: mode (full rebuild from the
--                          plant's 30-Jun anchor, or the incremental live
--                          window), and the ledger-vs-Odoo comparison it made.
--
-- Idempotent (IF NOT EXISTS throughout), per db/migrate.js's convention.

CREATE TABLE IF NOT EXISTS odoo_stock_ledger (
  record_date  DATE           NOT NULL,
  ledger_key   VARCHAR(40)    NOT NULL,
  opening      NUMERIC(14,3),           -- NULL = not known (unsettled / negative / held)
  inflow       NUMERIC(14,3),
  outflow      NUMERIC(14,3),
  balance      NUMERIC(14,3),           -- running arithmetic, even when not published
  closing      NUMERIC(14,3),           -- published closing; NULL whenever `reason` is set
  settled      BOOLEAN        NOT NULL DEFAULT FALSE,
  status       VARCHAR(20)    NOT NULL, -- ok | unsettled | negative | broken | held | human_anchor | no_anchor
  reason       TEXT,
  written      JSONB          NOT NULL DEFAULT '{}'::jsonb,
  computed_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (record_date, ledger_key)
);

CREATE INDEX IF NOT EXISTS idx_odoo_stock_ledger_key_date
  ON odoo_stock_ledger (ledger_key, record_date DESC);

CREATE TABLE IF NOT EXISTS odoo_stock_onhand (
  id            BIGSERIAL      PRIMARY KEY,
  taken_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  product_code  VARCHAR(40)    NOT NULL,
  scope         VARCHAR(20)    NOT NULL,  -- 'internal' (all internal locations) | 'pile' (plant WIP pile)
  qty           NUMERIC(14,3)  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_odoo_stock_onhand_code_time
  ON odoo_stock_onhand (product_code, scope, taken_at DESC);

CREATE TABLE IF NOT EXISTS odoo_stock_ledger_runs (
  id           BIGSERIAL      PRIMARY KEY,
  started_at   TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  mode         VARCHAR(20)    NOT NULL,  -- 'full' | 'incremental' | 'dry_run'
  from_date    DATE,
  to_date      DATE,
  result       JSONB
);

CREATE INDEX IF NOT EXISTS idx_odoo_stock_ledger_runs_mode_time
  ON odoo_stock_ledger_runs (mode, started_at DESC);
