/*
  routes/auth.js — Login, Logout, Change Password

  POST /api/auth/login           → credentials in, JWT + user out.
                                   Tracks failed attempts per account and
                                   locks it for LOCKOUT_MINUTES after
                                   LOCKOUT_MAX_ATTEMPTS consecutive failures.
  POST /api/auth/change-password → verifies current password, stores a new
                                   bcrypt hash, revokes every old token
                                   (token_version bump) and returns a fresh one.
  POST /api/auth/logout          → bumps token_version = revokes ALL of this
                                   user's outstanding tokens, on every device.
  GET  /api/auth/me              → current user info from a valid token.
*/

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { requireAuth }  = require('../middleware/auth');
const { validate, z }  = require('../middleware/validate');
const authTokens = require('../services/authTokens');
const authMail   = require('../services/authMail');

const router = express.Router();

const LOCKOUT_MAX     = parseInt(process.env.LOCKOUT_MAX_ATTEMPTS || '5', 10);
const LOCKOUT_MINUTES = parseInt(process.env.LOCKOUT_MINUTES || '15', 10);
const SALT_ROUNDS     = 12;

function signToken(user) {
  return jwt.sign(
    {
      id:       user.id,
      username: user.username,
      name:     user.full_name,
      role:     user.role,
      dept:     user.department,
      level:    user.level,          // 'officer' | 'senior' | 'hod' — see requireApprover
      ver:      user.token_version, // must match users.token_version (revocation)
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function audit(userId, username, action, ip) {
  return db.query(
    'INSERT INTO audit_log (user_id, username, action, ip_address) VALUES ($1, $2, $3, $4)',
    [userId, username, action, ip]
  );
}

// ── POST /api/auth/login ─────────────────────────────────────
const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(50),
  password: z.string().min(1).max(128),
});

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.validated.body;

    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];

    // Same generic 401 whether the username exists, is wrong, or is disabled
    if (!user || !user.active) {
      await audit(user ? user.id : null, username, 'LOGIN_FAILED', req.ip);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.max(1, Math.ceil((new Date(user.locked_until) - Date.now()) / 60000));
      await audit(user.id, username, 'LOGIN_LOCKED', req.ip);
      return res.status(423).json({
        error: `Account locked after repeated failed attempts. Try again in ${minutesLeft} min.`,
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      const attempts = user.failed_attempts + 1;
      if (attempts >= LOCKOUT_MAX) {
        await db.query(
          'UPDATE users SET failed_attempts = 0, locked_until = NOW() + make_interval(mins => $2) WHERE id = $1',
          [user.id, LOCKOUT_MINUTES]
        );
        await audit(user.id, username, 'ACCOUNT_LOCKED', req.ip);
      } else {
        await db.query('UPDATE users SET failed_attempts = $2 WHERE id = $1', [user.id, attempts]);
        await audit(user.id, username, 'LOGIN_FAILED', req.ip);
      }
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // Success — clear lockout counters, stamp last_login
    await db.query(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1',
      [user.id]
    );
    await audit(user.id, user.username, 'LOGIN', req.ip);

    res.json({
      token: signToken(user),
      mustChangePassword: user.must_change_password,
      user: {
        id:       user.id,
        username: user.username,
        name:     user.full_name,
        role:     user.role,
        dept:     user.department,
        level:    user.level,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/change-password ───────────────────────────
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string()
    .min(10, 'must be at least 10 characters')
    .max(128)
    .regex(/[A-Za-z]/, 'must contain a letter')
    .regex(/[0-9]/,    'must contain a digit'),
});

router.post('/change-password', requireAuth, validate(changePasswordSchema), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.validated.body;

    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      await audit(user.id, user.username, 'PASSWORD_CHANGE_FAILED', req.ip);
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must differ from the current one.' });
    }

    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const updated = await db.query(
      `UPDATE users
       SET password_hash = $2, must_change_password = false,
           token_version = token_version + 1
       WHERE id = $1
       RETURNING *`,
      [user.id, hash]
    );
    await audit(user.id, user.username, 'PASSWORD_CHANGED', req.ip);

    // The version bump just revoked every old token (including the one used
    // for this request) — hand back a fresh one so the session continues.
    res.json({ token: signToken(updated.rows[0]), message: 'Password changed successfully.' });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ─────────────────────────────────────────
// Returns current user info from the token (browser uses on page load to verify session)
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, username, full_name, role, department, level, last_login, must_change_password
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    // Revoke every outstanding token for this user (all devices), then log it
    await db.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
    await audit(req.user.id, req.user.username, 'LOGOUT', req.ip);
    res.json({ message: 'Logged out successfully.' });
  } catch (err) { next(err); }
});

/* ══════════════════════════════════════════════════════════════════════
   EMAIL-LINK FLOWS — activation, password reset, address verification.

   All three are UNAUTHENTICATED by necessity: the whole point is to reach
   someone who cannot sign in. The token is the credential, so each route
   leans on services/authTokens.js for single-use, time-boxed redemption,
   and none of them reveals whether an account or address exists.
══════════════════════════════════════════════════════════════════════ */

// ── POST /api/auth/forgot-password ───────────────────────────
/* Deliberately answers identically whether or not the address is on an
   account. Anything else turns this into an address oracle — "which of our
   staff use the MIS" is exactly the list a phisher wants, and the endpoint
   is public. The audit log records the difference; the response does not.

   "Identically" has to cover how long the answer takes as well as what it
   says, which is why the reply goes out before the token and the email.

   Rate limiting is applied at the app level (credentialRateLimit in
   server.js) alongside login and change-password. */
const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(120),
});

const SAME_ANSWER = {
  message: 'If that address belongs to an MIS account, a reset link is on its way. Check your inbox, including junk mail.',
};

router.post('/forgot-password', validate(forgotSchema), async (req, res, next) => {
  const { email } = req.validated.body;

  let user;
  try {
    ({ rows: [user] } = await db.query(
      `SELECT id, username, full_name, email, active FROM users
        WHERE LOWER(email) = $1 AND active = true`, [email]));
  } catch (err) { return next(err); }

  /* Answered here, before any work that only a real account causes. Equal
     status codes and equal bodies were half the fix: issuing the token and,
     far more expensively, the SMTP round trip are work an unknown address
     skips entirely. Measured from the app server, the handshake to
     smtp.office365.com costs ~1.9s before AUTH is even attempted, against
     ~20ms for the unknown branch — with the send inside the response, that
     gap is the same enumeration oracle, read off a stopwatch instead of a
     status code. Both branches now reply after the same single lookup, and
     what is left to measure is a hit versus a miss on that one SELECT:
     ~0.04ms, inside ~1ms of ordinary query noise. */
  res.json(SAME_ANSWER);

  /* The reply has already gone, so next(err) would be writing to a finished
     response. From here the audit row and the server log are the only
     places anything can be reported. */
  try {
    if (!user) {
      // Logged so a burst of these is visible, without telling the caller.
      await audit(null, email, 'PASSWORD_RESET_REQUESTED_UNKNOWN', req.ip);
      return;
    }

    const token = await authTokens.issue({ userId: user.id, email: user.email, purpose: 'reset' });
    const mail  = await authMail.sendReset({ to: user.email, fullName: user.full_name, token });
    await audit(user.id, user.username, mail.sent ? 'PASSWORD_RESET_SENT' : 'PASSWORD_RESET_SEND_FAILED', req.ip);
    if (!mail.sent) req.log?.error({ reason: mail.reason, username: user.username }, 'password reset email not sent');
  } catch (err) {
    req.log?.error({ err, username: user && user.username }, 'password reset could not be issued');
  }
});

// ── GET /api/auth/token/:purpose/:token ──────────────────────
/* Checks a link before showing the form behind it, so someone arriving with
   a dead link is told why instead of filling in a password that will be
   rejected. Returns only what the page needs to greet them — never the
   email, which would make a guessed token an address disclosure. */
router.get('/token/:purpose/:token', async (req, res, next) => {
  try {
    const { purpose, token } = req.params;
    if (!['invite', 'reset', 'verify'].includes(purpose)) {
      return res.status(400).json({ error: 'Unknown link type.' });
    }
    const r = await authTokens.inspect(token, purpose);
    if (!r.ok) return res.status(400).json({ error: LINK_ERRORS[r.reason], reason: r.reason });
    res.json({ ok: true, username: r.token.username, full_name: r.token.full_name, purpose });
  } catch (err) { next(err); }
});

const LINK_ERRORS = {
  invalid: 'This link is not valid. It may have been replaced by a newer one, or the account may no longer be active. Ask IT for a new link.',
  expired: 'This link has expired. Request a new one from the sign-in page, or ask IT to send another.',
  used:    'This link has already been used. If you did not use it, tell IT immediately — then sign in, or request a new link.',
};

// ── POST /api/auth/set-password ──────────────────────────────
/* Redeems an invite or reset token and sets the password. Same strength
   rules as change-password: those are the rules, not the rules for people
   who still remember their old password. */
const setPasswordSchema = z.object({
  token:   z.string().min(10).max(200),
  purpose: z.enum(['invite', 'reset']),
  newPassword: z.string()
    .min(10, 'must be at least 10 characters')
    .max(128)
    .regex(/[A-Za-z]/, 'must contain a letter')
    .regex(/[0-9]/,    'must contain a digit'),
});

router.post('/set-password', validate(setPasswordSchema), async (req, res, next) => {
  try {
    const { token, purpose, newPassword } = req.validated.body;

    const r = await authTokens.inspect(token, purpose);
    if (!r.ok) return res.status(400).json({ error: LINK_ERRORS[r.reason], reason: r.reason });
    const row = r.token;

    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);

    /* Token spend and password write commit together. If the token stayed
       unspent after a successful write it would remain a working key to the
       account; if the password write failed after the spend, the user would
       be locked out holding a dead link. */
    await db.withTransaction(async (client) => {
      await authTokens.spend(row.id, client);
      await client.query(
        `UPDATE users
            SET password_hash = $2, must_change_password = false,
                failed_attempts = 0, locked_until = NULL,
                token_version = token_version + 1,
                -- Following a link proves the mailbox reaches them, which is
                -- exactly what verification asks. No separate step needed.
                email_verified = true
          WHERE id = $1`, [row.user_id, hash]);
      await client.query(
        `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.user_id, row.username,
         purpose === 'invite' ? 'ACCOUNT_ACTIVATED' : 'PASSWORD_RESET_COMPLETED',
         row.username, `via emailed ${purpose} link`, req.ip]);
    });

    res.json({
      ok: true,
      username: row.username,
      message: purpose === 'invite'
        ? 'Your account is ready. Sign in with your new password.'
        : 'Your password has been changed. Sign in with the new one.',
    });
  } catch (err) {
    if (err.code === 'TOKEN_RACE') {
      return res.status(409).json({ error: LINK_ERRORS.used, reason: 'used' });
    }
    next(err);
  }
});

// ── POST /api/auth/verify-email ──────────────────────────────
/* Confirms an address reaches its owner. Grants nothing else — no password
   change, no session — so a leaked verify link is not a way in. */
router.post('/verify-email', validate(z.object({ token: z.string().min(10).max(200) })), async (req, res, next) => {
  try {
    const { token } = req.validated.body;
    const r = await authTokens.inspect(token, 'verify');
    if (!r.ok) return res.status(400).json({ error: LINK_ERRORS[r.reason], reason: r.reason });

    await db.withTransaction(async (client) => {
      await authTokens.spend(r.token.id, client);
      await client.query('UPDATE users SET email_verified = true WHERE id = $1', [r.token.user_id]);
      await client.query(
        `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.token.user_id, r.token.username, 'EMAIL_VERIFIED', r.token.username, r.token.email, req.ip]);
    });

    res.json({ ok: true, message: 'Thank you — your email address is confirmed.' });
  } catch (err) {
    if (err.code === 'TOKEN_RACE') return res.status(409).json({ error: LINK_ERRORS.used, reason: 'used' });
    next(err);
  }
});

module.exports = router;
