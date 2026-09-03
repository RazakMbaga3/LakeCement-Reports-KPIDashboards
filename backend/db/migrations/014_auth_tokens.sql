-- 014: single-use, expiring tokens for the account-activation and
-- password-reset links sent by email.
--
-- Until now the only way to give someone a password was for an
-- administrator to generate one and read it out. That does not scale past a
-- handful of people (37 accounts are still on the passwords committed in
-- db/seed.js), and it means the password travels through whoever is
-- standing nearby. A mailed link moves the secret onto the channel we have
-- just spent two migrations establishing as the user's identity.
--
-- WHAT IS STORED IS A HASH, NOT THE TOKEN. The token only ever exists in
-- the email and in the URL the user clicks; the row holds sha256(token).
-- A read-only leak of this table therefore grants nothing — the same
-- reasoning as password_hash on users, and the reason this is not just a
-- `reset_token` column of random text.
--
-- PURPOSE distinguishes the three flows so one cannot be replayed as
-- another: an 'invite' link (long-lived, first credential) must not double
-- as a 'reset' (short-lived, re-credential), and 'verify' proves control of
-- the mailbox without granting a password change at all.

CREATE TABLE IF NOT EXISTS auth_tokens (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64)    NOT NULL,          -- sha256 hex of the emailed token
  purpose     VARCHAR(20) NOT NULL CHECK (purpose IN ('invite', 'reset', 'verify')),
  email       VARCHAR(120) NOT NULL,         -- where it was sent; a later address change invalidates it
  expires_at  TIMESTAMP   NOT NULL,
  used_at     TIMESTAMP,                     -- non-null = spent, never reusable
  created_by  INTEGER     REFERENCES users(id),   -- the admin who sent it; NULL for self-service
  created_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
  UNIQUE (token_hash)
);

-- The lookup every redemption does: hash → live token.
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens (token_hash);
-- Supports "invalidate this user's other outstanding tokens of this kind".
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens (user_id, purpose) WHERE used_at IS NULL;

COMMENT ON TABLE auth_tokens IS
  'Single-use email links for account activation, password reset and address verification. Stores sha256 of the token, never the token itself. See backend/services/authTokens.js.';
