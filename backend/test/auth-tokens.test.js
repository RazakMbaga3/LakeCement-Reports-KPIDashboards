/*
  test/auth-tokens.test.js — the email-link token store.

  These links are bearer credentials: whoever holds one can set a password on
  someone else's account. So the properties worth asserting are the ones that
  keep a leaked, stale or replayed link from working — not the happy path.

  Runs against the real database (it is a store; mocking it would test the
  mock). Everything it creates is prefixed 'tok_test_' and removed in the
  teardown at the bottom.

  Usage: node --test test/auth-tokens.test.js   (from backend/)
*/
require('dotenv').config();
const test   = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const db = require('../db');
const T  = require('../services/authTokens');

const USERNAME = 'tok_test_user';
const EMAIL    = 'tok.test@lakecement.co.tz';
let userId;

test.before(async () => {
  await db.query("DELETE FROM users WHERE username = $1", [USERNAME]);
  const { rows } = await db.query(
    `INSERT INTO users (username, password_hash, full_name, role, department, level, email, active)
     VALUES ($1,'x','Token Test','production','TEST','hod',$2,true) RETURNING id`,
    [USERNAME, EMAIL]);
  userId = rows[0].id;
});

test.after(async () => {
  await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM users WHERE id = $1', [userId]);
});

test('the plaintext token is never stored — only its sha256', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  const { rows } = await db.query(
    'SELECT token_hash FROM auth_tokens WHERE user_id = $1 AND used_at IS NULL', [userId]);

  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token, 'the raw token must not be in the row');
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'));

  // And nothing anywhere in the table equals the token itself.
  const { rows: leak } = await db.query(
    'SELECT 1 FROM auth_tokens WHERE token_hash = $1 OR email = $1', [token]);
  assert.equal(leak.length, 0, 'the token must not appear in any column');
});

test('a valid token inspects cleanly', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  const r = await T.inspect(token, 'reset');
  assert.equal(r.ok, true);
  assert.equal(r.token.username, USERNAME);
});

test('a token is single-use', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  const first = await T.inspect(token, 'reset');
  assert.equal(first.ok, true);

  await db.withTransaction(client => T.spend(first.token.id, client));

  const second = await T.inspect(token, 'reset');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'used');
});

test('spending an already-spent token throws rather than silently succeeding', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  const r = await T.inspect(token, 'reset');
  await db.withTransaction(client => T.spend(r.token.id, client));

  await assert.rejects(
    () => db.withTransaction(client => T.spend(r.token.id, client)),
    err => err.code === 'TOKEN_RACE',
    'a double-spend must be detectable, not a no-op');
});

test('issuing a new token of the same purpose kills the previous one', async () => {
  const older = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  const newer = await T.issue({ userId, email: EMAIL, purpose: 'reset' });

  assert.equal((await T.inspect(older, 'reset')).reason, 'used',
    'the superseded link must stop working — two live reset links is the replay window single-use exists to close');
  assert.equal((await T.inspect(newer, 'reset')).ok, true);
});

test('an expired token is refused', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  await db.query(
    "UPDATE auth_tokens SET expires_at = NOW() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL",
    [userId]);
  const r = await T.inspect(token, 'reset');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('a token cannot be redeemed as a different purpose', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'invite' });
  assert.equal((await T.inspect(token, 'reset')).reason, 'invalid',
    'an invite link (7 days) must not be usable as a reset, or the shorter window means nothing');
  assert.equal((await T.inspect(token, 'invite')).ok, true);
});

test('a token stops working once the account is deactivated', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  await db.query('UPDATE users SET active = false WHERE id = $1', [userId]);
  try {
    assert.equal((await T.inspect(token, 'reset')).reason, 'invalid',
      'deactivating someone must not be undone by a link still sitting in their inbox');
  } finally {
    await db.query('UPDATE users SET active = true WHERE id = $1', [userId]);
  }
});

test('a token stops working once the address it was sent to is changed', async () => {
  const token = await T.issue({ userId, email: EMAIL, purpose: 'reset' });
  await db.query('UPDATE users SET email = $2 WHERE id = $1', [userId, 'tok.test.moved@lakecement.co.tz']);
  try {
    assert.equal((await T.inspect(token, 'reset')).reason, 'invalid',
      'correcting a typo\'d address must invalidate the link that went to the wrong mailbox');
  } finally {
    await db.query('UPDATE users SET email = $2 WHERE id = $1', [userId, EMAIL]);
  }
});

test('a garbage token is refused without error', async () => {
  const r = await T.inspect('not-a-real-token-at-all', 'reset');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('tokens are long and unpredictable', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(T.generateToken());
  assert.equal(seen.size, 500, 'no collisions in 500 tokens');
  // 32 bytes base64url -> 43 chars, no padding.
  assert.ok(T.generateToken().length >= 40);
  assert.match(T.generateToken(), /^[A-Za-z0-9_-]+$/, 'must be URL-safe with no characters needing escaping');
});

test('the three purposes have sensibly different lifetimes', () => {
  assert.ok(T.TTL_MINUTES.reset < T.TTL_MINUTES.invite,
    'a reset window must be shorter than an invite window — the account already works');
  assert.equal(T.TTL_MINUTES.reset, 60);
});
