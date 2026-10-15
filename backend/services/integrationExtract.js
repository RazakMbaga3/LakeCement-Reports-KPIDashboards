/*
  services/integrationExtract.js — live figures for the Integration Package tab.

  The two e-mail reports (Vehicles at Factory Without Order, Sales vs Target)
  belong to the collaborator's Python package in integration/sales-dashboard/.
  Their numbers are produced by THEIR functions, not reimplemented here:
  web_extract.py calls them read-only and prints one JSON object, and this
  module runs it.

  Why a process per request, not a resident Python service: pandas + pg8000
  cost 100-200 MB while they run, and the droplet already carries the
  Streamlit app; a short-lived child frees that the moment it exits.

  Safety rules, each one deliberate:
    - ONE Python child at a time across both reports (memory), and
      concurrent callers for the same report share one run (no stampede).
    - The child gets a MINIMAL environment. process.env holds the JWT secret,
      the database password and the Graph secret, none of which Python needs;
      and python-dotenv never overrides an existing variable, so an inherited
      PG_* would silently beat integration/sales-dashboard/.env.
    - No shell; arguments as an array; killed after TIMEOUT_MS; stdout capped.
    - Results are cached (vehicles 2 min, sales-vs-target 30 min). When Odoo
      fails, the last good result is served marked `stale`, never a zero.
    - Nothing here can send an e-mail: web_extract.py has no sending path and
      refuses to start outside programs, and the sending scripts are not even
      in the repo (see integration/sales-dashboard/PROVENANCE.json).
*/
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_DIR = path.resolve(__dirname, '../../integration/sales-dashboard');
const TIMEOUT_MS = 100 * 1000;        // under nginx's 120 s proxy_read_timeout for /api/
const MAX_STDOUT = 8 * 1024 * 1024;
const TTL = { vehicles: 2 * 60 * 1000, 'sales-vs-target': 30 * 60 * 1000 };
const MAX_DATES = 10;                 // sales-vs-target cache entries kept

/* Overridable for tests (a fake interpreter) and for a non-standard install. */
let cfg = {};
function configure(next) { cfg = { ...next }; _cache.clear(); _inflight.clear(); }

function appDir() { return cfg.dir || process.env.SALES_APP_DIR || DEFAULT_DIR; }
function pythonPath() {
  if (cfg.python) return cfg.python;
  if (process.env.SALES_APP_PYTHON) return process.env.SALES_APP_PYTHON;
  return process.platform === 'win32'
    ? path.join(appDir(), '.venv', 'Scripts', 'python.exe')
    : path.join(appDir(), '.venv', 'bin', 'python');
}
function scriptPath() { return cfg.script || path.join(appDir(), 'web_extract.py'); }

function isInstalled() {
  return fs.existsSync(pythonPath()) && fs.existsSync(scriptPath());
}

/* Only what Python needs to start, find its temp dir and speak UTF-8. */
function childEnv() {
  const env = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  // One spelling each: on Windows process.env is case-insensitive, so 'Path'
  // and 'PATH' would both resolve and hand the child duplicate keys.
  for (const k of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'HOME']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
}

const STATUS_BY_EXIT = { 2: 'odoo_unreachable', 3: 'not_configured', 4: 'bad_arguments' };

function runOnce(args) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(pythonPath(), [scriptPath(), ...args], {
        cwd: appDir(), env: childEnv(), shell: false, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, status: 'error', message: `Could not start Python: ${err.message}` });
      return;
    }
    const out = [];
    let outBytes = 0, stderrTail = '', killedFor = null;
    const timer = setTimeout(() => { killedFor = 'timeout'; child.kill('SIGKILL'); }, cfg.timeoutMs || TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT) { killedFor = 'too_large'; child.kill('SIGKILL'); return; }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000); });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, status: 'error', message: `Could not run Python: ${err.message}` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killedFor === 'timeout') {
        return resolve({ ok: false, status: 'timeout',
          message: `Odoo did not answer within ${Math.round((cfg.timeoutMs || TIMEOUT_MS) / 1000)} s.` });
      }
      if (killedFor === 'too_large') {
        return resolve({ ok: false, status: 'error', message: 'The report output was unexpectedly large.' });
      }
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(out).toString('utf8')); } catch { /* handled below */ }
      if (!parsed || typeof parsed !== 'object') {
        return resolve({ ok: false, status: 'error',
          message: `The report script returned no readable result (exit ${code}).`, detail: stderrTail.trim().slice(-500) });
      }
      if (code === 0 && parsed.ok) return resolve({ ok: true, data: parsed });
      resolve({
        ok: false,
        status: parsed.status || STATUS_BY_EXIT[code] || 'error',
        message: parsed.message || `The report script failed (exit ${code}).`,
      });
    });
  });
}

/* One Python child at a time, globally. */
let _queue = Promise.resolve();
function enqueue(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}

const _cache = new Map();     // key -> { at, result }   (last GOOD result only)
const _inflight = new Map();  // key -> Promise

function remember(key, result) {
  _cache.delete(key);
  _cache.set(key, { at: Date.now(), result });
  const svt = [..._cache.keys()].filter(k => k.startsWith('sales-vs-target|'));
  while (svt.length > MAX_DATES) _cache.delete(svt.shift());
}

async function get(report, args, key) {
  if (!isInstalled()) {
    return { ok: false, status: 'not_installed',
      message: 'The Integration Package (Python) is not installed on this server yet.' };
  }
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL[report]) return { ...hit.result, cached_at: new Date(hit.at).toISOString() };
  if (_inflight.has(key)) return _inflight.get(key);

  const p = enqueue(() => runOnce(args)).then(res => {
    _inflight.delete(key);
    if (res.ok) {
      remember(key, res);
      return { ...res, cached_at: new Date().toISOString() };
    }
    const last = _cache.get(key);
    if (last) {
      return { ...last.result, cached_at: new Date(last.at).toISOString(),
        stale: true, stale_reason: res.message, stale_status: res.status };
    }
    return res;
  });
  _inflight.set(key, p);
  return p;
}

function getVehicles() {
  return get('vehicles', ['vehicles'], 'vehicles');
}

/* date: 'YYYY-MM-DD' or undefined (= yesterday, like the 08:00 mail). */
function getSalesVsTarget(date) {
  return get('sales-vs-target', ['sales-vs-target', ...(date ? ['--date', date] : [])],
    `sales-vs-target|${date || 'default'}`);
}

/* The e-mail schedule facts, copied from the collaborator's (non-vendored)
   Windows scripts. Read per call so an update needs no restart. */
function getEmailSchedule() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir(), 'email-schedule.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  getVehicles, getSalesVsTarget, getEmailSchedule, isInstalled, configure,
  // exported for tests
  _childEnv: childEnv,
  _expireForTests() { for (const v of _cache.values()) v.at = 0; },
};
