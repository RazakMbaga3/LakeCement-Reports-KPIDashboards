-- 033_odoo_production_header_fields.sql
--
-- The Odoo team's 2026-10-08 deploy added the fields we had been asking for
-- in docs/email-drafts/03-odoo-production-missing-fields.md: coal_ncv,
-- running_hours, tph, kiln_feed_value, plus the approval state (state /
-- approval_status) and mill_type.
--
-- The mirror table had no columns for them, so they were parsed out of the
-- payload and then silently dropped before reaching daily_reports. That is
-- why coal_ncv read null in the report even after the mapper was fixed.
--
-- coal_ncv is the one that matters most: it is the only missing input to the
-- Specific Thermal Energy Consumption KPI (kcal/kg clinker), which has read
-- null since 2026-06-30 because its previous source — the `ncv` field on the
-- limestone form — stopped being submitted.
--
-- All nullable with no default: an entry from before this deploy genuinely
-- has no NCV, and a zero there would be a fabricated reading feeding a
-- divisor. Backfill is by re-pulling, which the content hash now forces
-- (the new fields are part of it).

ALTER TABLE odoo_production_entries
  ADD COLUMN IF NOT EXISTS coal_ncv        numeric,
  ADD COLUMN IF NOT EXISTS running_hours   numeric,
  ADD COLUMN IF NOT EXISTS tph             numeric,
  ADD COLUMN IF NOT EXISTS kiln_feed_value numeric,
  ADD COLUMN IF NOT EXISTS state           varchar(64),
  ADD COLUMN IF NOT EXISTS approval_status varchar(64),
  ADD COLUMN IF NOT EXISTS mill_type       varchar(32);

COMMENT ON COLUMN odoo_production_entries.coal_ncv IS
  'Coal net calorific value, kcal/kg, as reported on the Odoo entry (2026-10-08 onward). Feeds the coal_ncv fact on the production report.';
COMMENT ON COLUMN odoo_production_entries.running_hours IS
  'Decimal hours (e.g. 23.833), not HH:MM — the Odoo API returns a float even though the Odoo form view displays 20:18.';
COMMENT ON COLUMN odoo_production_entries.approval_status IS
  'Odoo-side approval state. Entries have been observed as "Approved"; this is what lets a future pull filter to approved entries only.';
