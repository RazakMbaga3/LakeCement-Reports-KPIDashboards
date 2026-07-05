/*
  server.js — Lake Cement MIS Backend Entry Point

  This file:
  1. Loads configuration from .env
  2. Creates the Express app
  3. Registers middleware (cors, json parsing)
  4. Mounts all route files under /api/...
  5. Starts listening on the configured port

  CONCEPT: Express app flow
  Every incoming request travels through this pipeline:
    Request → CORS check → JSON parse → Route match → Response
*/

require('dotenv').config();
const express       = require('express');
const cors          = require('cors');
const helmet        = require('helmet');
const { rateLimit } = require('express-rate-limit');

// Import route files
const authRoutes    = require('./routes/auth');
const reportsRoutes = require('./routes/reports');
const kpiRoutes     = require('./routes/kpi');

const app  = express();
const PORT = process.env.PORT || 5000;

// Loud warnings for unsafe configuration — better than silently running open
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes('change-me')) {
  console.warn('⚠️  JWT_SECRET is missing or a placeholder — set a real secret in .env');
}
if ((process.env.ALLOWED_ORIGIN || '*').trim() === '*') {
  console.warn('⚠️  CORS is open to all origins (ALLOWED_ORIGIN=*) — restrict in production');
}

// ── MIDDLEWARE ───────────────────────────────────────────────

// Security headers (X-Content-Type-Options, HSTS, frame denial, …)
app.use(helmet());

// CORS — allows the browser (on the same network) to call this API.
// ALLOWED_ORIGIN accepts a comma-separated list of exact origins,
// e.g. "http://192.168.1.20,http://mis.lakecement.local"
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Renewed-Token'], // sliding-session renewal (middleware/auth.js)
}));

// Rate-limit the auth endpoints — blunts password brute-forcing from one IP;
// per-account lockout in routes/auth.js covers distributed attempts.
app.use('/api/auth', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: parseInt(process.env.AUTH_RATE_LIMIT || '30', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts from this device. Wait a few minutes and try again.' },
}));

// Parse incoming JSON request bodies
// Without this, req.body would be undefined
app.use(express.json({ limit: '10mb' }));

// Log every incoming request (useful during development)
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── API ROUTES ───────────────────────────────────────────────
// All routes are prefixed with /api/
// So the browser calls: http://server-ip:5000/api/auth/login

app.use('/api/auth',    authRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/kpi',     kpiRoutes);

// ── HEALTH CHECK ─────────────────────────────────────────────
// A simple endpoint to verify the server is running
// Visit http://localhost:5000/api/health in your browser to test
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    app:       'Lake Cement MIS Backend',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── SERVE FRONTEND (Production) ──────────────────────────────
// In production, Nginx serves the frontend.
// In development, the browser opens the HTML files directly.
// Uncomment these lines (and require 'path') if Node should serve it too:
// const path = require('path');
// app.use(express.static(path.join(__dirname, '..')));
// app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

// ── 404 HANDLER ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────
// Route handlers call next(err); the stack is logged here, and the client
// only ever sees a generic message — never internals.
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err.stack || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── START SERVER ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Lake Cement MIS — Backend Server         ║');
  console.log(`║   Running on http://localhost:${PORT}         ║`);
  console.log('╚════════════════════════════════════════════╝');
  console.log('');
});
