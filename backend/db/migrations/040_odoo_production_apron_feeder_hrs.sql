-- 040_odoo_production_apron_feeder_hrs.sql
--
-- Crusher TPH is CRUSHER PRODUCTION / APRON FEEDER RUNNING HOURS (Razak,
-- 2026-10-15), read from Odoo's Crusher Production Entry. The Odoo
-- production_report API has carried `apron_feeder_hrs` on every Crusher entry
-- since the 2026-10-08 deploy (docs/email-drafts/05), but the mirror table had
-- no column for it, so odooProductionMapper.js parsed the entry and the value
-- was dropped before it could reach daily_reports.
--
-- Why apron hours and not running_hours: the apron feeder is what actually
-- feeds limestone into the crusher, so its hours are the hours the crusher
-- was producing. Running hours include time the crusher turns with nothing
-- on the feeder. Measured 2026-10-15, monthly TPH on each basis
-- (Σproduction ÷ Σhours, Odoo state='complete'):
--
--     month     apron   running        Mines dept KPI report ("Crusher Output")
--     2026-01   207.5   182.0          206.6
--     2026-02   191.2   168.1          190.2
--     2026-03   169.9   143.9          170.7
--     2026-04   177.4   145.7          183.0
--     2026-05   193.8   157.1          194.8
--     2026-06   184.5   147.6          184.9
--
-- The Mines department's own monthly KPI report (kpi_monthly, mines /
-- crusher-output, backfilled from the M-11 workbook) tracks the apron basis
-- to within ~1 TPH in five of those six months and the running basis in none.
--
-- Nullable, no default: Odoo's own crusher_production_entry has apron hours
-- on every approved entry from 2023-08-19 on (1,083 entries, none 0) and on
-- none before that (259 entries, all NULL — the field did not exist yet). A
-- 0 here would be a fabricated reading in the divisor of TPH.
--
-- Backfill is by re-pulling the production feed. The mapper adds the value
-- to the entry's content hash only when it is present, so crusher rows hash
-- differently once (and are counted as updated) while every other stage's
-- rows keep their existing hash.

ALTER TABLE odoo_production_entries
  ADD COLUMN IF NOT EXISTS apron_feeder_hrs numeric;

COMMENT ON COLUMN odoo_production_entries.apron_feeder_hrs IS
  'Crusher apron-feeder running hours, decimal (17.45 = 17 h 27 min), as on Odoo''s Crusher Production Entry. Crusher entries only; NULL on every other stage. Divisor of crusher TPH (fact ls_crusher_apron_hrs).';
