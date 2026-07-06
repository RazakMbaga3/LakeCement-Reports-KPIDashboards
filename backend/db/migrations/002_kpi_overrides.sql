-- 002: audited manual overrides for formula-computed KPI values.
-- Rows are PERMANENT — an override is never deleted, only cleared
-- (cleared_at/cleared_by) or superseded by a newer row. The partial
-- unique index guarantees at most one ACTIVE override per KPI/period.

CREATE TABLE IF NOT EXISTS kpi_overrides (
  id              SERIAL PRIMARY KEY,
  kpi_key         VARCHAR(100)  NOT NULL,
  year            SMALLINT      NOT NULL,
  month           SMALLINT      NOT NULL CHECK (month BETWEEN 1 AND 12),
  value_override  NUMERIC(14,4) NOT NULL,
  value_computed  NUMERIC(14,4),            -- what the formula said at override time
  reason          TEXT          NOT NULL,   -- mandatory — who/why is the whole point
  created_by      INTEGER REFERENCES users(id),
  created_by_name VARCHAR(100),
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  cleared_at      TIMESTAMP,
  cleared_by      INTEGER REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_kpi_overrides_period ON kpi_overrides(kpi_key, year, month);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_overrides_active
  ON kpi_overrides(kpi_key, year, month) WHERE cleared_at IS NULL;
