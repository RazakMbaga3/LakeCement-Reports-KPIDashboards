-- 001: account lockout, token revocation, forced password change.
-- Idempotent — safe to run on a database created from an already-current
-- schema.sql (see db/migrate.js header for the convention).

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts      INTEGER   NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until         TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN   NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version        INTEGER   NOT NULL DEFAULT 0;

-- Every account existing before this migration still carries a well-known
-- seed password (they are committed in db/seed.js) — force a change at
-- next login. On a fresh database this matches zero rows.
UPDATE users SET must_change_password = true WHERE must_change_password = false;
