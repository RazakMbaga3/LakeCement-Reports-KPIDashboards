-- 005: quarry weighbridge ticket log (Odoo "Uploaded_Data" export).
-- Many rows per day, deduped by ticket_no — same "multi-row-per-day" shape
-- as `stoppages`, so it gets its own table rather than the generic
-- one-blob-per-day `daily_reports`.

CREATE TABLE IF NOT EXISTS weighbridge_tickets (
  id             SERIAL PRIMARY KEY,
  ticket_no      VARCHAR(50)  UNIQUE NOT NULL,
  vendor         VARCHAR(150),
  vehicle        VARCHAR(50),
  transfer_type  VARCHAR(30),            -- raw Odoo value: 'Production' | 'Internal'
  movement_type  VARCHAR(120) NOT NULL,  -- e.g. 'South Mine to Pile (through Crusher)'
  product        VARCHAR(50)  NOT NULL,  -- 'HG','LG1','OB/CLAY','LIMESTONE SPG', etc.
  ticket_date    DATE         NOT NULL,
  net_qty        NUMERIC(10,3) NOT NULL,
  gross_datetime VARCHAR(40),            -- raw exported timestamp, informational only
  imported_by    INTEGER REFERENCES users(id),
  imported_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_weighbridge_date     ON weighbridge_tickets(ticket_date);
CREATE INDEX IF NOT EXISTS idx_weighbridge_movement ON weighbridge_tickets(movement_type);
