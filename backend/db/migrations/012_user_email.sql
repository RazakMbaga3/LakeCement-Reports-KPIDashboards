-- 012: gives `users` an email identity, so an account can be traced to a
-- named person, verified, and recovered.
--
-- Until now the only identifier was `username` — a department role slot
-- ('production_senior', 'stores_officer'), not a person. That made three
-- things impossible: telling who actually entered or approved a reading,
-- resetting a password without an administrator handing one out, and
-- addressing the morning KPI digest / watchdog alerts to anyone at all.
--
-- `username` deliberately STAYS the primary login and the key every access
-- rule is written against (role + level are derived from the user row, and
-- FORM_ACCESS / KPI_EDIT_DEPTS key off `role`). Email is added ALONGSIDE it
-- as a second, unique identity — nothing about the authorization model
-- changes here.
--
-- NULLable on purpose: the 2 AUTOMATION service accounts have no mailbox
-- and never will, and human accounts are backfilled department by
-- department as returns come in. A partial unique index (rather than a
-- plain UNIQUE constraint) lets many rows hold NULL while still refusing
-- two accounts on the same address.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email          VARCHAR(120);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone          VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_no       VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

-- Case-insensitive uniqueness: 'Lokesh.Thota@…' and 'lokesh.thota@…' are
-- the same mailbox, and a duplicate account is exactly what this migration
-- exists to prevent. NULL emails are excluded from the index entirely.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq
  ON users (LOWER(email))
  WHERE email IS NOT NULL;

-- Cheap sanity gate, not full RFC 5322 validation — that belongs in the
-- application layer. This only refuses the obviously-wrong values that
-- would otherwise sit in the table looking legitimate: no '@', leading or
-- trailing whitespace, or an empty local/domain part.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_shape_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_email_shape_check
      CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
  END IF;
END $$;

COMMENT ON COLUMN users.email IS
  'Company mailbox. Identity + recovery address; NOT the login (username is). NULL for AUTOMATION service accounts and for humans not yet returned by their department.';
COMMENT ON COLUMN users.email_verified IS
  'True once the user has followed a verification link sent to users.email. Set false again whenever the address changes.';
