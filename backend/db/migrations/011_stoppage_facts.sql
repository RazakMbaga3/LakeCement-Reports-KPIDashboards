-- 011: granular stoppage facts (equipment x cause x named fault x day),
-- imported from the plant's monthly "Stoppage report" workbooks (see
-- scripts/import-stoppage-facts.js). Additive alongside the existing
-- coarse daily_reports form_type='stoppage' model (stop_<equip>_<cause>
-- minutes fields, entered shift/day-level) — that model is untouched and
-- keeps covering the months this table has no data for (Apr-Jun 2026).
--
-- Why a new table rather than reusing the `stoppages` table already in
-- schema.sql: `stoppages` was never wired to any route or script (grep
-- confirms zero INSERT/SELECT against it anywhere in the codebase) and its
-- shape (start_time/end_time/duration_hours/reason/category) doesn't match
-- what the workbook actually gives us (a decimal HOURS value per named
-- fault per calendar day, no incident start/end clock time). Repurposing a
-- dead table with a different shape would be more confusing than leaving
-- it alone and adding a table that matches the source data exactly.
CREATE TABLE IF NOT EXISTS stoppage_facts (
  id                 SERIAL PRIMARY KEY,
  equipment          VARCHAR(20)   NOT NULL,  -- STOP_EQUIPMENT key (services/insights.js): crusher|rm|cm_coal|kiln|cm1|cm2|packing
  cause              VARCHAR(20)   NOT NULL,  -- STOP_CAUSES key: mech|ei|prod|planned|power|other
  fault_description  VARCHAR(300)  NOT NULL,  -- the workbook's own named-fault row label, verbatim (trimmed)
  record_date        DATE          NOT NULL,
  hours               NUMERIC(6,2) NOT NULL CHECK (hours > 0),  -- source unit is HOURS, not minutes (unlike stop_<equip>_<cause>)
  source_file        VARCHAR(200),             -- workbook filename this row was last (re)imported from
  imported_by        INTEGER REFERENCES users(id),
  imported_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  -- Natural key = one named fault, on one equipment, under one cause bucket,
  -- on one calendar day. Lets the importer be re-run idempotently for the
  -- same month (upsert) and lets a later, corrected workbook for a month
  -- already imported simply overwrite the old hours — same "later wins"
  -- convention as scripts/import-kpi-monthly-xlsx.js.
  UNIQUE (equipment, cause, fault_description, record_date)
);

CREATE INDEX IF NOT EXISTS idx_stoppage_facts_date        ON stoppage_facts(record_date);
CREATE INDEX IF NOT EXISTS idx_stoppage_facts_equip_date   ON stoppage_facts(equipment, record_date);
-- Month-range rollups (MTBF-vs-month chart) - EXTRACT, not DATE_TRUNC, to
-- match the existing idx_daily_reports_month convention (DATE_TRUNC isn't
-- IMMUTABLE on this Postgres build).
CREATE INDEX IF NOT EXISTS idx_stoppage_facts_month ON stoppage_facts(
  equipment, (EXTRACT(YEAR FROM record_date)), (EXTRACT(MONTH FROM record_date))
);
