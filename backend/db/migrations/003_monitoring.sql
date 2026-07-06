-- 003: monitoring & observability — browser error reports and fired
-- operational alerts (watchdog dedupes against this table).

CREATE TABLE IF NOT EXISTS client_errors (
  id         SERIAL PRIMARY KEY,
  username   VARCHAR(50),                -- soft-identified from token when present
  page       VARCHAR(120),
  message    VARCHAR(500) NOT NULL,
  source     VARCHAR(300),
  line       INTEGER,
  stack      VARCHAR(2000),
  user_agent VARCHAR(300),
  ip_address VARCHAR(45),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_errors_date ON client_errors(created_at);

CREATE TABLE IF NOT EXISTS alerts (
  id         SERIAL PRIMARY KEY,
  kind       VARCHAR(80)  NOT NULL,      -- e.g. 'missed-entry:kiln', 'health-down', 'disk-low'
  detail     TEXT,
  emailed    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_kind_date ON alerts(kind, created_at);
