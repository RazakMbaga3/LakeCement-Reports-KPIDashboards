-- 004: add remarks to kpi_monthly so the dashboard's REMARKS column can be
-- populated from real source data instead of staying hardcoded HTML text.

ALTER TABLE kpi_monthly ADD COLUMN IF NOT EXISTS remarks TEXT;
