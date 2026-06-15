/*
  routes/auth.js — Login & Logout

  CONCEPT: What is a route?
  A route is a URL + HTTP method pair that the server responds to.

  POST /api/auth/login  → browser sends username + password, gets back a token
  POST /api/auth/logout → browser tells server it's done (token is discarded client-side)
  GET  /api/auth/me     → browser asks "who am I?" using its current token
*/

const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const db         = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    // 1. Find user in database
    const result = await db.query(
      'SELECT * FROM users WHERE username = $1 AND active = true',
      [username.toLowerCase().trim()]
    );

    const user = result.rows[0];

    if (!user) {
      // Don't reveal whether username exists or not (security best practice)
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // 2. Compare submitted password against the stored hash
    // bcrypt.compare does the magic — it hashes the submitted password
    // the same way and checks if they match. The plain password is never stored.
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    // 3. Create a JWT token — this is the "badge" the browser carries on all future requests
    const token = jwt.sign(
      {
        id:       user.id,
        username: user.username,
        name:     user.full_name,
        role:     user.role,
        dept:     user.department,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }  // token expires in 8 hours
    );

    // 4. Update last_login timestamp
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // 5. Log the action in audit log
    await db.query(
      'INSERT INTO audit_log (user_id, username, action, ip_address) VALUES ($1, $2, $3, $4)',
      [user.id, user.username, 'LOGIN', req.ip]
    );

    // 6. Send token + user info back to browser
    res.json({
      token,
      user: {
        id:       user.id,
        username: user.username,
        name:     user.full_name,
        role:     user.role,
        dept:     user.department,
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
// Returns current user info from the token (browser uses on page load to verify session)
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, username, full_name, role, department, last_login FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── POST /api/auth/logout ────────────────────────────────────
// JWT tokens are stateless — logout is handled by the browser deleting the token.
// We just log the action server-side.
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await db.query(
      'INSERT INTO audit_log (user_id, username, action, ip_address) VALUES ($1, $2, $3, $4)',
      [req.user.id, req.user.username, 'LOGOUT', req.ip]
    );
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
