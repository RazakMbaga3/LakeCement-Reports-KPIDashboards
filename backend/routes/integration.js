/*
  routes/integration.js — the Integration Package tab (integration-package.html).

  GET  /api/integration/vehicles               live "Vehicles at Factory Without Order" + its e-mail list
  GET  /api/integration/sales-vs-target?date=  live "Sales vs Target – Daily Report" + its e-mail matrix
  GET  /api/integration/status                 is the package installed, is the Sales Dashboard app up,
                                               and the e-mail schedule facts
  POST /api/integration/sales-app-session      issue the cookie that lets this browser open /sales-app/
  GET  /api/integration/sales-app-gate         nginx auth_request target for every /sales-app/ request

  Same audience as the Sales dashboard: COMMERCIAL_VIEW_ROLES (md, management,
  sales), checked server-side here and mirrored by canViewSales() in the
  sidebar. Nothing here sends e-mail or schedules anything — the e-mails stay
  on the collaborator's Windows PC (integration/sales-dashboard/PROVENANCE.json).

  WHY A COOKIE GATE IN FRONT OF THE STREAMLIT APP
  /sales-app/ is the collaborator's Streamlit Sales Dashboard, proxied by nginx
  on our own origin so it can sit inside the tab. Its only protection would be
  its own users.toml login (no lockout, login sent over a websocket nginx cannot
  rate-limit), on the public internet, with all sales and customer figures
  behind it. Our login is a Bearer token in localStorage, which a browser does
  not send on an iframe's page and asset requests, so nginx cannot check it
  directly. Instead the page trades its Bearer token for a short-lived
  HttpOnly cookie scoped to /sales-app/, and nginx asks the gate below before
  every /sales-app/ request. The Streamlit login stays as a second layer.

  The cookie is signed with a key DERIVED from JWT_SECRET, never JWT_SECRET
  itself: otherwise a copied cookie would also verify as an API Bearer token.
*/
const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const extract = require('../services/integrationExtract');
const { COMMERCIAL_VIEW_ROLES } = require('../config/commercialAccess');

const router = express.Router();

const COOKIE = 'lcl_sales_app';
const COOKIE_PATH = '/sales-app/';
const COOKIE_TTL_SEC = 12 * 60 * 60;
const AUDIENCE = 'lcl-sales-app';
const SALES_APP_HEALTH = process.env.SALES_APP_HEALTH_URL || 'http://127.0.0.1:8501/sales-app/_stcore/health';
const DATA_START = '2026-04-01'; // the package fetches nothing earlier (odoo_client.DATA_START)

function cookieKey() {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update('lcl-sales-app-cookie-v1').digest();
}

function plantToday() {
  // Africa/Dar_es_Salaam is UTC+3 all year (no DST).
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/* Odoo/Python failure statuses map to 503 (temporary), bad input to 400. */
function send(res, result) {
  if (result.ok) return res.json(result);
  const code = result.status === 'bad_arguments' ? 400 : 503;
  res.status(code).json(result);
}

router.get('/vehicles',
  requireAuth, requireRole(...COMMERCIAL_VIEW_ROLES),
  async (req, res, next) => {
    try { send(res, await extract.getVehicles()); } catch (err) { next(err); }
  });

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(d => !Number.isNaN(Date.parse(d)), 'not a real date')
  .refine(d => d >= DATA_START, `no data before ${DATA_START}`)
  .refine(d => d <= plantToday(), 'cannot be in the future');

router.get('/sales-vs-target',
  requireAuth, requireRole(...COMMERCIAL_VIEW_ROLES),
  validate(z.object({ date: zDate.optional() }), 'query'),
  async (req, res, next) => {
    try { send(res, await extract.getSalesVsTarget(req.validated.query.date)); } catch (err) { next(err); }
  });

router.get('/status',
  requireAuth, requireRole(...COMMERCIAL_VIEW_ROLES),
  async (req, res, next) => {
    try {
      let reachable = false;
      try {
        const r = await fetch(SALES_APP_HEALTH, { signal: AbortSignal.timeout(3000) });
        reachable = r.ok;
      } catch { /* not running */ }
      res.json({
        installed: extract.isInstalled(),
        sales_app: { reachable, path: COOKIE_PATH },
        email_schedule: extract.getEmailSchedule(),
      });
    } catch (err) { next(err); }
  });

router.post('/sales-app-session',
  requireAuth, requireRole(...COMMERCIAL_VIEW_ROLES),
  (req, res) => {
    const token = jwt.sign(
      { sub: String(req.user.id), ver: req.user.ver ?? 0 },
      cookieKey(),
      { audience: AUDIENCE, expiresIn: COOKIE_TTL_SEC });
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; Path=${COOKIE_PATH}; Max-Age=${COOKIE_TTL_SEC}; HttpOnly; Secure; SameSite=Strict`);
    res.json({ ok: true, expires_in: COOKIE_TTL_SEC });
  });

/* Called by nginx (auth_request) before every /sales-app/ request, so a short
   in-memory cache keeps it to one DB lookup per user per minute. A logout,
   password change, deactivation or role change takes effect within that minute. */
const _gateCache = new Map(); // token -> expiresAt
const GATE_CACHE_MS = 60 * 1000;

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

router.get('/sales-app-gate', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token) return res.sendStatus(401);
    const cached = _gateCache.get(token);
    if (cached && cached > Date.now()) return res.sendStatus(204);

    let claims;
    try { claims = jwt.verify(token, cookieKey(), { audience: AUDIENCE }); }
    catch { return res.sendStatus(401); }

    const { rows } = await db.query(
      'SELECT active, token_version, must_change_password, role FROM users WHERE id = $1',
      [Number(claims.sub)]);
    const u = rows[0];
    if (!u || !u.active || u.must_change_password
        || (claims.ver ?? 0) !== u.token_version
        || !COMMERCIAL_VIEW_ROLES.includes(u.role)) {
      _gateCache.delete(token);
      return res.sendStatus(401);
    }
    if (_gateCache.size > 500) _gateCache.clear();
    _gateCache.set(token, Math.min(Date.now() + GATE_CACHE_MS, claims.exp * 1000));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

module.exports = router;
