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
    (pg_is_in_recovery() = false). Pool of 2, 30 s statement timeout, and an
    application_name so the Odoo admin can see exactly what we run.
  • Encrypted. TLS is on by default (sslmode 'require'); the server accepts
    TLS 1.3. 'verify-full' is supported once the server has a certificate
    valid for its hostname.
  • Never reads secrets. The login can technically read Odoo users' password
    hashes, 2FA secrets, API keys and payroll — a gap reported to the Odoo
    admin, not a feature. assertSafeSql() refuses any statement that names
    those tables/columns, so no code path here can pull them by accident.
*/

require('../config/env');
const { Pool } = require('pg');
const logger = require('./logger');

/* Tables and columns this dashboard must never read, whatever the login allows.
   Matched case-insensitively against the SQL text before it is sent. */
const FORBIDDEN = [
  /\bres_users_apikeys\b/i,
  /\btotp_secret\b/i,
  /\bpassword\b/i,
  /\bhr_payslip\w*/i,
  /\bhr_contract\w*/i,
  /\bhr_employee\w*\.(identification_id|passport_id|ssnid|bank_account_id)\b/i,
  /\bres_partner_bank\b/i,
  /\bauth_\w*\b/i,
];

function assertSafeSql(sql) {
  for (const re of FORBIDDEN) {
    if (re.test(sql)) {
      const err = new Error(`odooDb: refused a query that touches a protected table/column (${re})`);
      err.code = 'ODOO_DB_FORBIDDEN';
      throw err;
    }
  }
}

function isConfigured() {
  return Boolean(process.env.ODOO_PG_HOST && process.env.ODOO_PG_USER && process.env.ODOO_PG_DATABASE);
}

function sslOption() {
  const mode = String(process.env.ODOO_PG_SSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true, servername: process.env.ODOO_PG_HOST };
  throw new Error(`ODOO_PG_SSLMODE=${mode} is not one of disable, require, verify-full`);
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

module.exports = { isConfigured, query, ping, close, assertSafeSql, _FORBIDDEN: FORBIDDEN };
