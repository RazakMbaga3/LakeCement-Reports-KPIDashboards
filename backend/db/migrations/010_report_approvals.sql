-- 010: real backend-enforced approval workflow for daily_reports, replacing
-- the cosmetic client-side-only DRAFT/SUBMITTED distinction that lived
-- inside the JSONB `data._status` field (forms/form-persist.js). Modeled
-- on kpi_overrides' audited created_by/cleared_by pattern (schema.sql).
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS status            VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS approved_by       INTEGER REFERENCES users(id);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMP;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS rejected_by       INTEGER REFERENCES users(id);
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS rejected_at       TIMESTAMP;
ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_reports_status_check') THEN
    ALTER TABLE daily_reports ADD CONSTRAINT daily_reports_status_check
      CHECK (status IN ('draft','pending_approval','approved','rejected'));
  END IF;
END $$;

-- One-time backfill: every row that exists today was submitted under the
-- old no-workflow model and is already load-bearing downstream (KPI
-- formulas, dashboards). Leaving it at the column default 'draft' would
-- make the new Approvals UI show years of history as a false backlog on
-- day one — treat all pre-existing rows as already final.
UPDATE daily_reports SET status = 'approved' WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_daily_reports_status ON daily_reports(status);
