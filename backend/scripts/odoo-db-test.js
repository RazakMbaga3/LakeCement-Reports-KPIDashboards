/*
  scripts/odoo-db-test.js — check the read-only Odoo database connection.

  Usage:  npm run odoo:db-test

  Prints who we connected as, whether the session is read-only and
  encrypted, and the freshest row in each Odoo table the dashboard reads.
  Exits 1 if the connection is not configured or fails.
*/
require('../config/env');
const odooDb = require('../services/odooDb');

const FRESHNESS = [
  ['Production entries',        `SELECT max(date)::text AS latest FROM custom_production_entry`],
  ['Crusher production entries', `SELECT max(date)::text AS latest FROM crusher_production_entry`],
  ['CPP entries',               `SELECT max(date)::text AS latest FROM cpp_entry`],
  ['Waste material (overburden)', `SELECT max(entry_date)::text AS latest FROM waste_material_entry`],
  ['Stock moves',               `SELECT max(date)::text AS latest FROM stock_move WHERE state = 'done'`],
];

(async () => {
  if (!odooDb.isConfigured()) {
    console.error('Not configured: set ODOO_PG_HOST, ODOO_PG_PORT, ODOO_PG_DATABASE, ODOO_PG_USER, ODOO_PG_PASSWORD in backend/.env');
    process.exit(1);
  }
  const who = await odooDb.ping();
  console.log(`Connected as ${who.login} to ${who.database} — read-only: ${who.read_only}, TLS: ${who.tls}`);
  for (const [label, sql] of FRESHNESS) {
    const [r] = await odooDb.query(sql);
    console.log(`  ${label.padEnd(30)} latest ${r.latest}`);
  }
  await odooDb.close();
})().catch(async err => {
  console.error('Odoo DB test failed:', err.code || '', err.message);
  await odooDb.close().catch(() => {});
  process.exit(1);
});
