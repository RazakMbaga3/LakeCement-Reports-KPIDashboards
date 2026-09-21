-- 019: audit trail for Odoo correcting a previously-stored production value.
--
-- Phase 3 of the Odoo Production Autofill plan (services/odooProductionAutofill.js)
-- treats Odoo as the source of record for the fields it owns: if a shift
-- officer typed one number and Odoo's production_report later disagrees,
-- Odoo's value overwrites it (decision A, 2026-09-21). An overwrite that
-- happens with no visible trace is indistinguishable from data corruption to
-- whoever notices a number changed, so every overwrite is logged here first.
--
-- Rows are permanent and append-only — there is nothing to "clear" the way
-- kpi_overrides has an active/cleared state, since this is a log of events
-- that already happened, not a currently-standing override to undo.
CREATE TABLE IF NOT EXISTS production_odoo_overrides (
  id              SERIAL PRIMARY KEY,
  record_date     DATE          NOT NULL,
  field           VARCHAR(50)   NOT NULL,
  previous_value  NUMERIC(14,3),              -- NULL only if the field somehow had a non-numeric value before
  odoo_value      NUMERIC(14,3) NOT NULL,
  entry_refs      TEXT,                       -- Odoo entry reference(s) behind this value, comma-joined
  created_at      TIMESTAMP     NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_production_odoo_overrides_date ON production_odoo_overrides(record_date);
