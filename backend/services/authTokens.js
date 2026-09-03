/*
  services/authTokens.js — issuing and redeeming the single-use email links
  behind account activation, password reset and address verification.

  THE TOKEN IS NEVER STORED. issue() returns it once, for the email; the row
  keeps only sha256(token). A read-only leak of auth_tokens therefore grants
  nothing, which is the same reason users.password_hash exists rather than a
  password column. redeem() hashes what arrives and looks that up.

  Every redemption is single-use and time-boxed, and redeeming one token
  invalidates the user's other outstanding tokens of the same purpose — so a
  forwarded or re-requested link cannot be replayed after the real one has
  been used.
*/
const crypto = require('crypto');
const db = require('../db');

/* How long each kind of link stays valid.

   'invite' is days because it is the first contact with someone who may not
   check mail daily, and a dead invite means an administrator has to be
   asked for another. 'reset' is an hour because the account already works —
   the user is at their desk, and a long window is only extra exposure.
   'verify' proves control of a mailbox and grants nothing on its own, so
   its window is generous. */
const TTL_MINUTES = { invite: 7 * 24 * 60, reset: 60, verify: 14 * 24 * 60 };

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/* 32 bytes of CSPRNG output. Base64url so it survives a URL untouched —
   no percent-encoding to get wrong on either side of the link. */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/* Issues a token for `purpose` and returns the plaintext ONCE. Pass an open
   client when this must share the caller's transaction (creating a user and
   its invite together should not half-succeed). */
async function issue({ userId, email, purpose, createdBy = null }, client = db) {
  if (!TTL_MINUTES[purpose]) throw new Error(`unknown token purpose: ${purpose}`);
  const token = generateToken();

  /* Supersede this user's other live tokens of the same purpose. Two valid
     reset links at once means the older one still works after the newer is
     used, which is exactly the replay window single-use is meant to close. */
  await client.query(
    `UPDATE auth_tokens SET used_at = NOW()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose]
  );

  await client.query(
    `INSERT INTO auth_tokens (user_id, token_hash, purpose, email, expires_at, created_by)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval, $6)`,
    [userId, sha256(token), purpose, email, String(TTL_MINUTES[purpose]), createdBy]
  );

  return token;
}

/* Looks a token up without spending it — for the page that renders the
   "choose your password" form before anything is submitted.

   Returns { ok: true, token } or { ok: false, reason }. `reason` is
   deliberately coarse ('invalid' | 'expired' | 'used'): the caller shows the
   user why their link failed, and none of the three reveals whether an
   account exists. */
async function inspect(token, purpose) {
  const { rows } = await db.query(
    `SELECT t.*, u.username, u.full_name, u.active
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.purpose = $2`,
    [sha256(token), purpose]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at) <= new Date()) return { ok: false, reason: 'expired' };
  /* A deactivated account must not be revivable by an old link — otherwise
     deactivating someone is undone by whatever is still in their inbox. */
  if (!row.active) return { ok: false, reason: 'invalid' };

  // The address the link was sent to must still be the account's address:
  // if an admin has since corrected a typo'd email, the link that went to
  // the wrong mailbox stops working.
  const { rows: [u] } = await db.query('SELECT email FROM users WHERE id = $1', [row.user_id]);
  if (!u || (u.email || '').toLowerCase() !== (row.email || '').toLowerCase()) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, token: row };
}

/* Spends the token. Runs inside the caller's transaction so the token and
   whatever it authorises (a new password, a verified flag) commit together
   — a password set against a token that stayed unspent would be reusable. */
async function spend(tokenRowId, client) {
  const { rowCount } = await client.query(
    `UPDATE auth_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
    [tokenRowId]
  );
  // 0 rows means something else spent it between inspect() and here.
  if (rowCount === 0) throw Object.assign(new Error('token already used'), { code: 'TOKEN_RACE' });
}

module.exports = { issue, inspect, spend, generateToken, sha256, TTL_MINUTES };
