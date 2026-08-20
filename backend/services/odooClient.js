/*
  services/odooClient.js — minimal Odoo External API client (JSON-RPC).

  Talks to Odoo exactly the way Odoo's own external-API docs describe:
  authenticate once via the "common" service, then call model methods
  through "object".execute_kw. No odoo-xmlrpc/odoo-jsonrpc dependency —
  Node 18+'s built-in fetch is enough for the two calls this needs.

  Configured entirely from .env (ODOO_URL/ODOO_DB/ODOO_USERNAME/ODOO_API_KEY —
  see .env.example). Every export throws if that config is missing; callers
  (odooSync.js, scripts/odoo-test-connection.js) decide whether that's fatal
  or just "integration not wired up yet".

  No pull/upsert logic lives here on purpose — this is the transport only.
  Dataset-specific pulls belong in services/odooSync.js once a model/fields
  are confirmed with the Odoo team.
*/

function config() {
  const { ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY } = process.env;
  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) {
    throw new Error('Odoo is not configured — set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY in .env');
  }
  return { url: ODOO_URL.replace(/\/+$/, ''), db: ODOO_DB, username: ODOO_USERNAME, apiKey: ODOO_API_KEY };
}

let cachedUid = null; // an Odoo login is valid for the life of this process

// Odoo may be unreachable (wrong network path, VPN hiccup, server down) —
// without a timeout, a single stalled connection hangs the request (or the
// daily sync cron) forever with no self-recovery. Callers already treat any
// thrown error as "Odoo unreachable", so a timeout just needs to throw.
const ODOO_TIMEOUT_MS = 15000;

async function rpc(url, service, method, args) {
  let res;
  try {
    res = await fetch(url + '/jsonrpc', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Date.now() }),
      signal:  AbortSignal.timeout(ODOO_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Odoo request timed out after ${ODOO_TIMEOUT_MS}ms calling ${service}.${method}`, { cause: err });
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status} calling ${service}.${method}`);

  const body = await res.json();
  if (body.error) {
    const msg = body.error.data?.message || body.error.message || 'unknown Odoo error';
    throw new Error(`Odoo RPC error in ${service}.${method}: ${msg}`);
  }
  return body.result;
}

/* Server identification — no auth required, so it's the cheapest possible
   "is Odoo even reachable" check. */
function version() {
  const { url } = config();
  return rpc(url, 'common', 'version', []);
}

/* Logs in and caches the uid. force:true re-authenticates (e.g. after the
   API key was rotated without restarting the service). */
async function authenticate({ force = false } = {}) {
  if (cachedUid && !force) return cachedUid;
  const { url, db, username, apiKey } = config();
  const uid = await rpc(url, 'common', 'authenticate', [db, username, apiKey, {}]);
  if (!uid) throw new Error('Odoo authentication failed — check ODOO_USERNAME/ODOO_API_KEY');
  cachedUid = uid;
  return uid;
}

/* Generic model call — mirrors Odoo's own
   execute_kw(db, uid, password, model, method, args, kwargs). */
async function executeKw(model, method, args = [], kwargs = {}) {
  const { url, db, apiKey } = config();
  const uid = await authenticate();
  return rpc(url, 'object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
}

/* Convenience wrappers over execute_kw for the two things any new
   integration needs first: reading records, and discovering field names. */
function searchRead(model, domain = [], fields = [], opts = {}) {
  return executeKw(model, 'search_read', [domain, fields], opts);
}

function fieldsGet(model, opts = {}) {
  return executeKw(model, 'fields_get', [], { attributes: ['string', 'type', 'help'], ...opts });
}

module.exports = { version, authenticate, executeKw, searchRead, fieldsGet };
