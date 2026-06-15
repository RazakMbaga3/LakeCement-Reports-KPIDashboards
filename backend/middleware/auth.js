/*
  middleware/auth.js — JWT Token Verification

  CONCEPT: What is middleware?
  Middleware is code that runs BETWEEN the browser's request arriving
  and the actual route handler doing its work.

  Think of it as a security door:
    Browser request → [this middleware checks the badge] → route handler

  If the badge (token) is valid → call next() to let them through
  If invalid → send 401 Unauthorized and stop
*/

const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  // The token is sent in the request header: "Authorization: Bearer <token>"
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // extract token after "Bearer "

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    // Verify the token using our secret key
    // If the token was tampered with or expired, this throws an error
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach the user info to the request so routes can use it
    // e.g. req.user.id, req.user.role, req.user.username
    req.user = decoded;
    next(); // all good — pass to the route handler

  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token. Please log in again.' });
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
