-- 009: adds the 3-tier Officer/Senior/HOD model to users, orthogonal to
-- `role` (which already means "department" throughout the codebase —
-- PERMISSIONS, FORM_ACCESS, KPI_EDIT_DEPTS, requireRole calls, sidebar
-- filtering — see forms/access-registry.js's header). Officer/Senior get
-- identical form/KPI view-edit rights to their department's HOD; only the
-- new approve/reject gate (migration 010 + backend/middleware/approval.js)
-- reads this column. Corporate/oversight accounts (admin, md, management,
-- planthead) are single-tier and simply default to 'hod' as an inert
-- sentinel — they own no FORM_ACCESS entries, so level is never consulted
-- for them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS level VARCHAR(10) NOT NULL DEFAULT 'hod';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_level_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_level_check CHECK (level IN ('officer','senior','hod'));
  END IF;
END $$;
