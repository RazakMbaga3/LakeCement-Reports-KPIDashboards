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

module.exports = router;
