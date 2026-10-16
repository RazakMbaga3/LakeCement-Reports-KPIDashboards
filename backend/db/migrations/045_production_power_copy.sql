-- 045_production_power_copy.sql
--
-- Bookkeeping for services/powerToProduction.js, which copies the Electrical
-- department's section-wise kWh from the Power Consumption report
-- (form_type 'power-cons') into the Production Report's "TOTAL UNIT CONSUMED
-- (kWh)" row (form_type 'production', fields spc_*_kwh). See that file's
-- header for the field mapping and the Apr–Jun 2026 match counts behind it.
--
-- WHY A TABLE AND NOT A KEY INSIDE daily_reports.data
-- ---------------------------------------------------
-- The copy needs to know, per day and per field, whether the number now on
-- the Production report is one IT wrote (and nobody has changed since), or
-- one a person typed. Only the first may be corrected when Electrical later
-- corrects their report; the second must never be overwritten. Keeping that
-- provenance here, instead of as a bookkeeping key in the production row's
-- JSONB, leaves the row's data exactly what the form and the MIS export
-- expect — two other writers (the Odoo production autofill and the
-- officer's own form) merge into that same blob.
--
-- One row per (record_date, shift, field), in one of two states:
--   copied   — the copy wrote copied_value into the production row and the
--              row still holds it. A later correction on the Power
--              Consumption report may update it; if the power figure goes
--              away (report rejected, field cleared) the copy removes it.
--   conflict — the production row holds a different, non-placeholder value
--              that a person (or the plant's own Excel) put there. Nothing
--              was written; this row is the log of the disagreement.
-- A field with neither state has no row. The table is the CURRENT picture,
-- not a history — the history of every write the copy makes is in
-- report_revisions (action POWER_AUTOFILL, actor 'power-sync').
--
-- Idempotent: safe to re-run, and safe on a fresh database built from
-- schema.sql (which carries the same table and constraint).

CREATE TABLE IF NOT EXISTS production_power_copy (
  record_date      DATE          NOT NULL,
  shift            VARCHAR(10)   NOT NULL DEFAULT 'day',
  field            VARCHAR(50)   NOT NULL,                 -- a spc_*_kwh field of the Production report
  state            VARCHAR(10)   NOT NULL CHECK (state IN ('copied', 'conflict')),
  power_value      NUMERIC(14,2),                          -- what the Power Consumption report implies for this field
  production_value NUMERIC(14,2),                          -- what the Production report held when last checked
  copied_value     NUMERIC(14,2),                          -- state 'copied' only: the value the copy wrote
  power_status     VARCHAR(20),                            -- status of the power-cons report that was read
  state_since      TIMESTAMP     NOT NULL DEFAULT NOW(),   -- when this field entered its current state
  checked_at       TIMESTAMP     NOT NULL DEFAULT NOW(),   -- last time the copy evaluated it
  PRIMARY KEY (record_date, shift, field)
);
CREATE INDEX IF NOT EXISTS idx_production_power_copy_state ON production_power_copy(state, record_date);

-- report_revisions.action is pinned by a CHECK list (migration 024). The copy
-- writes daily_reports directly, like the Odoo autofill, so it logs its own
-- revision under a new action, POWER_AUTOFILL.
--
-- The constraint is EXTENDED, not restated: the current list is read back
-- out of the live constraint and POWER_AUTOFILL appended, so any value an
-- earlier migration added (other writers are adding their own) survives.
-- Restating a hard-coded list here would silently drop them.
DO $$
DECLARE
  c    record;
  vals text[];
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'report_revisions'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ~ '\maction\M'
  LOOP
    IF position('''POWER_AUTOFILL''' IN c.def) = 0 THEN
      SELECT array_agg(m[1]) INTO vals
        FROM regexp_matches(c.def, '''([A-Z_]+)''', 'g') AS m;
      EXECUTE format('ALTER TABLE report_revisions DROP CONSTRAINT %I', c.conname);
      EXECUTE format('ALTER TABLE report_revisions ADD CONSTRAINT %I CHECK (action IN (%s))',
                     c.conname,
                     (SELECT string_agg(quote_literal(v), ', ')
                        FROM unnest(vals || ARRAY['POWER_AUTOFILL']) AS v));
    END IF;
  END LOOP;
END $$;
