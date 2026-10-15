/*
  test/odoo-db.test.js — the safety rails of services/odooDb.js, the
  read-only connection to Odoo's own database. No network.

  The two properties under test are the ones that make it safe to point at
  the plant's LIVE ERP:

    1. It is inert until configured. With ODOO_PG_HOST unset a query fails
       fast with ODOO_DB_NOT_CONFIGURED, so a sync tick on a server that has
       no Odoo DB access skips instead of crashing or hanging.
    2. It refuses to read secrets. The login Odoo issued can technically
       read users' password hashes, 2FA secrets, API keys and payroll; no
       statement naming them may leave this process, whatever a caller does.

  Usage: node --test test/odoo-db.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');

const odooDb = require('../services/odooDb');

test('refuses statements that name protected tables or columns', () => {
  const refused = [
    'SELECT password FROM res_users',
    'select u.totp_secret from res_users u',
    'SELECT key FROM res_users_apikeys',
    'SELECT * FROM hr_payslip_line',
    'SELECT wage FROM hr_contract',
    'SELECT acc_number FROM res_partner_bank',
    'SELECT * FROM auth_totp_device',
  ];
  for (const sql of refused) {
    assert.throws(() => odooDb.assertSafeSql(sql), err => err.code === 'ODOO_DB_FORBIDDEN', sql);
  }
});

test('allows the operational tables the dashboard reads', () => {
  const allowed = [
    "SELECT date, production_qty, apron_feeder_hrs FROM crusher_production_entry WHERE state = 'complete'",
    'SELECT entry_date, no_of_trips, quantity FROM waste_material_entry',
    'SELECT date, gross_power, coal_consumption FROM cpp_entry',
    "SELECT m.product_uom_qty FROM stock_move m JOIN stock_picking_type t ON t.id = m.picking_type_id WHERE t.code = 'incoming'",
    'SELECT p.name FROM res_partner p',
  ];
  for (const sql of allowed) assert.doesNotThrow(() => odooDb.assertSafeSql(sql), sql);
});

test('is inert and fails fast when not configured', async () => {
  const saved = process.env.ODOO_PG_HOST;
  delete process.env.ODOO_PG_HOST;
  try {
    assert.equal(odooDb.isConfigured(), false);
    await assert.rejects(odooDb.query('SELECT 1'), err => err.code === 'ODOO_DB_NOT_CONFIGURED');
  } finally {
    if (saved !== undefined) process.env.ODOO_PG_HOST = saved;
  }
});

test('checks the forbidden list before the configuration, so a secret query never even queues', async () => {
  const saved = process.env.ODOO_PG_HOST;
  process.env.ODOO_PG_HOST = '127.0.0.1';
  process.env.ODOO_PG_USER = process.env.ODOO_PG_USER || 'x';
  process.env.ODOO_PG_DATABASE = process.env.ODOO_PG_DATABASE || 'x';
  try {
    await assert.rejects(odooDb.query('SELECT password FROM res_users'), err => err.code === 'ODOO_DB_FORBIDDEN');
  } finally {
    if (saved === undefined) delete process.env.ODOO_PG_HOST; else process.env.ODOO_PG_HOST = saved;
    await odooDb.close();
  }
});
