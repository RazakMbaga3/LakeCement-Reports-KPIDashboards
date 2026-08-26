/*
  middleware/auth.js — JWT verification with server-side revocation.

  requireAuth verifies the signature AND checks the user's row on every
  request (one indexed PK lookup — cheap at this scale) so that:

    • logout / password change revokes ALL outstanding tokens instantly:
      users.token_version must equal the token's `ver` claim,
    • deactivated accounts lose access immediately, not at token expiry,
    • accounts flagged must_change_password can reach only /api/auth/*
      (change-password, me, logout) until they set a new password.

  Sliding session: a token within RENEW_WINDOW of expiry gets a fresh
  replacement in the X-Renewed-Token response header. The frontend swaps
  it in (auth.js:_verifySessionOrRedirect), so someone working through a
  long shift is never logged out mid-entry.
*/

const jwt = require('jsonwebtoken');
const db  = require('../db');

const RENEW_WINDOW_SEC = 2 * 60 * 60; // re-issue when < 2h of life remains

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // after "Bearer "

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }

  try {
    const result = await db.query(
      'SELECT active, token_version, must_change_password, level FROM users WHERE id = $1',
      [decoded.id]
    );
    const u = result.rows[0];

    if (!u || !u.active) {
      return res.status(401).json({ error: 'Account is disabled or no longer exists.' });
    }
    if ((decoded.ver ?? 0) !== u.token_version) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    if (u.must_change_password && !req.originalUrl.startsWith('/api/auth/')) {
      return res.status(403).json({
        error: 'Password change required before continuing.',
        code:  'PASSWORD_CHANGE_REQUIRED',
      });
    }

    // Sliding session: quietly hand back a fresh token near expiry
    const secondsLeft = decoded.exp - Math.floor(Date.now() / 1000);
    if (secondsLeft > 0 && secondsLeft < RENEW_WINDOW_SEC) {
      const { iat, exp, ...claims } = decoded; // eslint-disable-line no-unused-vars
      res.set('X-Renewed-Token', jwt.sign(claims, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '8h',
      }));
    }

    // `level` comes from this fresh row, not the JWT claim — a promotion/
    // demotion (officer -> hod, say) must take effect immediately, the same
    // way active/token_version already do, not wait for token re-issue.
    req.user = { ...decoded, level: u.level };
    next();
  } catch (err) {
    next(err);
  }
}

// Role-based guard — call this to restrict a route to specific roles
// Example: router.get('/admin-data', requireAuth, requireRole('admin','md'), handler)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
