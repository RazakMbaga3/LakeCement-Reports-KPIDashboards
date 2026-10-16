/*
  services/odooDb.js — read-only connection to Odoo's own PostgreSQL database.

  ── Why this exists alongside the report endpoints ─────────────────────
  Everything else that reads Odoo goes through bespoke report URLs the Odoo
  team builds one at a time (production_report, dispatch_report, …). Several
  things the plant's reports need have no such URL and never will without
  another request to that team: Captive Power Plant entries, Waste Material
  Entry (overburden), Crusher Production Entry's apron-feeder hours, stock
  receipts and live stock on hand. On 2026-10-15 the plant was given a
  read-only database login, and every one of those was verified against the
  plant's own workbooks before anything was built on it (see the
  project memory "project-odoo-direct-db-access").

  ── What this module guarantees ────────────────────────────────────────
  • Inert until configured. With ODOO_PG_HOST unset, isConfigured() is false
    and query() throws ODOO_DB_NOT_CONFIGURED — callers skip, they never
    crash the server or a sync tick.
  • Read-only twice over. The login itself has no write grants, and every
    session is additionally opened with default_transaction_read_only=on,
    so a mistaken INSERT fails even if the login is ever widened.
  • Bounded load. This is the LIVE ERP the plant works in, not a replica
    (pg_is_in_recovery() = false). Pool of 2, 30 s statement timeout on the
    server AND a client-side query timeout, TCP keep-alive, and an
    application_name so the Odoo admin can see exactly what we run.
  • Talks only to the real server. The Odoo database presents a SELF-SIGNED
    certificate (CN ubuntu-s-4vcpu-8gb-intel-lon1-01, valid to 2032-05-27,
    SHA-256 AC:25:56:87:…:5B:ED:F1) on a public IP address, so ordinary
    certificate verification cannot work and "require" (encrypt, trust
    anyone) would let anyone on the network path present their own
    certificate, pass our login through and read the whole ERP. The default
    mode 'pinned' accepts ONLY that exact certificate, committed beside this
    file as config/odoo-db-server.pem. If the Odoo admin ever replaces the
    certificate, connections fail closed until the new one is pinned.
  • Reads only what the dashboard needs. The login can technically read
    Odoo users' password hashes, 2FA secrets, API keys, payroll and mail
    server passwords (RAID I-60 — reported to the Odoo admin, not a
    feature). assertSafeSql() therefore works as an ALLOWLIST: a statement
    may only name the operational tables in ALLOWED_TABLES, and anything
    else is refused before it leaves this process. Adding a table is a
    one-line, reviewable change below — it is deliberately not automatic.
*/

require('../config/env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const logger = require('./logger');

/* The operational tables the dashboard may read. Everything the plant's
   daily reports are built from lives here; nothing that holds credentials,
   payroll, personal identifiers or mail. */
const ALLOWED_TABLES = new Set([
  // production, crusher, power plant, mining, waste
  'custom_production_entry', 'custom_production_entry_line', 'crusher_production_entry',
  'cpp_entry', 'cpp_entry_line', 'custom_mining_transfer', 'waste_material_entry',
  'consumption_entry', 'consumption_entry_line', 'mining_bench_master',
  // stock
  'stock_move', 'stock_quant', 'stock_location', 'stock_picking', 'stock_picking_type',
  'stock_warehouse',
  // products, partners (names only — bank accounts are a separate, refused table)
  'product_product', 'product_template', 'product_category', 'uom_uom', 'res_partner',
  // lab / quality
  'cement_sample_analysis_entry', 'clinker_sample_analysis_entry', 'rawmill_sample_analysis_entry',
  'kilnfeed_sample_analysis_entry', 'coalmill_sample_analysis_entry', 'ls_pile_analysis_entry',
  'mined_ls_analysis_entry', 'quality_check_custom', 'quality_parameter', 'quality_parameter_line',
  'qc_parameter_product_line', 'qc_reason_line',
  // stoppages and maintenance
  'packing_plant_stoppage_entry', 'packing_plant_stoppage_reason', 'down_time_reason',
  'plant_stoppage_report', 'maintenance_request', 'maintenance_equipment', 'maintenance_team',
  // dispatch, sales and purchasing documents the dashboard already reads
  'sale_order', 'sale_order_line', 'custom_sale_token', 'purchase_order', 'purchase_order_line',
  'custom_purchase_token',
  // organisation (department names only)
  'hr_department',
  // the connection probe
  'pg_stat_ssl',
]);

/* Statements that must never be sent whatever tables they name. */
const FORBIDDEN = [
  /\bres_users\w*/i,
  /\btotp_secret\b/i,
  /\bpassword\b/i,
  /\bhr_payslip\w*/i,
  /\bhr_contract\w*/i,
  /\bhr_employee\w*/i,
  /\bres_partner_bank\b/i,
  /\bir_(config_parameter|mail_server|attachment)\b/i,
  /\bauth_\w*\b/i,
  /\b(pg_read_\w+|pg_ls_\w+|pg_stat_file|lo_\w+|dblink\w*|set_config)\b/i,
  /\bcopy\s/i,
  /;\s*\S/,                                  // a second statement
];

/* Table names a statement reads from: whatever follows FROM / JOIN, with
   EXTRACT(... FROM x) / SUBSTRING(... FROM n) style function syntax removed
   first, and set-returning functions (name followed by "(") skipped. A comma
   join ("FROM a, b") is refused outright — it is the one form this cannot
   see through, and nothing here needs it. */
function referencedTables(sql) {
  const flat = String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\b(extract|substring|trim|overlay|position)\s*\([^()]*\)/gi, ' ');
  if (/\bfrom\s+(?:only\s+)?(?:"?\w+"?\.)?"?\w+"?(?:\s+(?:as\s+)?\w+)?\s*,/i.test(flat)) {
    const err = new Error('odooDb: comma joins are not allowed — use explicit JOIN');
    err.code = 'ODOO_DB_FORBIDDEN';
    throw err;
  }
  /* Names a WITH clause defines shadow real tables inside the statement, so
     "FROM my_cte" reads the CTE, not a table — it must not need allowlisting. */
  const ctes = new Set();
  const cteRe = /(?:\bwith(?:\s+recursive)?|,)\s*([a-z_][a-z0-9_]*)\s+as\s*(?:not\s+materialized\s*|materialized\s*)?\(/gi;
  let c;
  while ((c = cteRe.exec(flat))) ctes.add(c[1].toLowerCase());

  const out = new Set();
  const re = /\b(?:from|join)\s+(?:lateral\s+)?(?:only\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?(\s*\()?/gi;
  let m;
  while ((m = re.exec(flat))) {
    if (m[2]) continue;                       // a function such as jsonb_array_elements(…)
    const name = m[1].toLowerCase();
    if (!ctes.has(name)) out.add(name);
  }
  return out;
}

function assertSafeSql(sql) {
  for (const re of FORBIDDEN) {
    if (re.test(sql)) {
      const err = new Error(`odooDb: refused a query that touches a protected table/column (${re})`);
      err.code = 'ODOO_DB_FORBIDDEN';
      throw err;
    }
  }
  for (const t of referencedTables(sql)) {
    if (!ALLOWED_TABLES.has(t)) {
      const err = new Error(`odooDb: refused — table "${t}" is not on the allowlist (see ALLOWED_TABLES in services/odooDb.js)`);
      err.code = 'ODOO_DB_FORBIDDEN';
      throw err;
    }
  }
}

function isConfigured() {
  return Boolean(process.env.ODOO_PG_HOST && process.env.ODOO_PG_USER && process.env.ODOO_PG_DATABASE);
}

const PINNED_CERT_FILE = process.env.ODOO_PG_SSLROOTCERT
  || path.join(__dirname, '..', 'config', 'odoo-db-server.pem');

function sslOption() {
  const mode = String(process.env.ODOO_PG_SSLMODE || 'pinned').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') {
    logger.warn('odooDb: ODOO_PG_SSLMODE=require encrypts but does not verify who answers — use pinned');
    return { rejectUnauthorized: false };
  }
  if (mode === 'verify-full') return { rejectUnauthorized: true, servername: process.env.ODOO_PG_HOST };
  if (mode === 'pinned') {
    const pem = fs.readFileSync(PINNED_CERT_FILE, 'utf8');
    const fingerprint = new crypto.X509Certificate(pem).fingerprint256;
    return {
      ca: pem,
      rejectUnauthorized: true,
      /* The server is addressed by IP and its certificate names a host that
         does not resolve, so a name check can never pass; the pin replaces
         it — only the certificate with this exact fingerprint is accepted. */
      checkServerIdentity: (_host, cert) => (cert && cert.fingerprint256 === fingerprint
        ? undefined
        : new Error('odooDb: the database server presented a certificate that is not the pinned one')),
    };
  }
  throw new Error(`ODOO_PG_SSLMODE=${mode} is not one of pinned, verify-full, require, disable`);
}

const STATEMENT_TIMEOUT_MS = Number(process.env.ODOO_PG_STATEMENT_TIMEOUT_MS) || 30000;

let _pool = null;
function pool() {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env.ODOO_PG_HOST,
    port: Number(process.env.ODOO_PG_PORT) || 5432,
    database: process.env.ODOO_PG_DATABASE,
    user: process.env.ODOO_PG_USER,
    password: process.env.ODOO_PG_PASSWORD,
    ssl: sslOption(),
    max: 2,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: 15000,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    /* The server enforces statement_timeout, but if the network silently
       drops the connection no reply ever comes and the await would hang for
       good — and the pull that made the call stays "already running" until
       the process restarts. The client-side limit sits a little above the
       server's so a normal timeout is still reported by Postgres. */
    query_timeout: STATEMENT_TIMEOUT_MS + 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    application_name: 'lcl-dashboard',
    /* Sent in the startup packet, so the session is read-only before the
       first statement runs — no race with a query issued on connect. */
    options: '-c default_transaction_read_only=on',
  });
  _pool.on('error', err => logger.warn({ err }, 'odooDb: idle connection error'));
  return _pool;
}

/* query(sql, params) -> rows. Throws ODOO_DB_NOT_CONFIGURED when unset. */
async function query(sql, params = []) {
  if (!isConfigured()) {
    const err = new Error('Odoo database connection is not configured (ODOO_PG_HOST / ODOO_PG_USER / ODOO_PG_DATABASE)');
    err.code = 'ODOO_DB_NOT_CONFIGURED';
    throw err;
  }
  assertSafeSql(sql);
  const started = Date.now();
  const res = await pool().query(sql, params);
  const ms = Date.now() - started;
  if (ms > 5000) logger.warn({ ms, rows: res.rowCount, sql: sql.slice(0, 120) }, 'odooDb: slow query');
  return res.rows;
}

/* Small health probe: who we are, whether the session really is read-only. */
async function ping() {
  const [row] = await query(
    `SELECT current_user AS login, current_database() AS database,
            current_setting('default_transaction_read_only') AS read_only,
            (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
            now() AS server_time`);
  return row;
}

async function close() {
  if (_pool) { const p = _pool; _pool = null; await p.end(); }
}

module.exports = {
  isConfigured, query, ping, close, assertSafeSql, referencedTables,
  ALLOWED_TABLES, _FORBIDDEN: FORBIDDEN,
};
