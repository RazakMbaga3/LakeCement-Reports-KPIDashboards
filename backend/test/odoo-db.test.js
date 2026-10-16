/*
  test/odoo-db.test.js — the safety rails of services/odooDb.js, the
  read-only connection to Odoo's own database. No network.

  The properties under test are the ones that make it safe to point at the
  plant's LIVE ERP:

    1. It is inert until configured. With ODOO_PG_HOST unset a query fails
       fast with ODOO_DB_NOT_CONFIGURED, so a sync tick on a server that has
       no Odoo DB access skips instead of crashing or hanging.
    2. It reads only an ALLOWLIST of operational tables. The login Odoo
       issued can technically read users' password hashes, 2FA secrets, API
       keys, payroll and mail-server passwords; no statement naming those —
       or any table not on the list, however it is spelt — may leave this
       process (RAID I-60; the first version used a denylist that
       "SELECT * FROM res_users" walked straight past).
    3. It talks only to the real server: the pinned certificate is the one
       committed beside the module, and only that fingerprint is accepted.

  Usage: node --test test/odoo-db.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const odooDb = require('../services/odooDb');

const refused = sql => assert.throws(() => odooDb.assertSafeSql(sql), err => err.code === 'ODOO_DB_FORBIDDEN', sql);
const allowed = sql => assert.doesNotThrow(() => odooDb.assertSafeSql(sql), sql);

test('refuses statements that name protected tables or columns', () => {
  [
    'SELECT password FROM res_users',
    'SELECT * FROM res_users',
    'SELECT u.* FROM res_users u',
    'select u.totp_secret from res_users u',
    'SELECT key FROM res_users_apikeys',
    'SELECT * FROM hr_payslip_line',
    'SELECT wage FROM hr_contract',
    'SELECT identification_id, passport_id, bank_account_id FROM hr_employee',
    'SELECT acc_number FROM res_partner_bank',
    "SELECT value FROM ir_config_parameter WHERE key = 'database.secret'",
    'SELECT smtp_pass FROM ir_mail_server',
    'SELECT * FROM auth_totp_device',
  ].forEach(refused);
});

test('refuses any table that is not on the allowlist, even an innocent-looking one', () => {
  [
    'SELECT body FROM mail_message',
    'SELECT * FROM auditlog_log',
    'SELECT * FROM payment_provider',
    'SELECT * FROM account_move_line',
    'SELECT * FROM public.res_company',
    'SELECT a.id FROM cpp_entry a JOIN mail_message m ON m.res_id = a.id',
    'SELECT * FROM (SELECT * FROM mail_followers) x',
  ].forEach(refused);
});

test('refuses comma joins, second statements and file/large-object functions', () => {
  refused('SELECT * FROM cpp_entry c, mail_message m');
  refused('SELECT 1; SELECT * FROM cpp_entry');
  refused("SELECT pg_read_file('/etc/passwd')");
  refused("SELECT lo_import('/etc/passwd')");
  allowed('SELECT 1 FROM cpp_entry;');   // a trailing semicolon alone is harmless
});

test('allows the operational tables the dashboard reads, in every form it writes them', () => {
  [
    "SELECT date, production_qty, apron_feeder_hrs FROM crusher_production_entry WHERE state = 'complete'",
    'SELECT entry_date, no_of_trips, quantity FROM waste_material_entry w LEFT JOIN res_partner p ON p.id = w.trans_id',
    'SELECT date, gross_power, coal_consumption FROM cpp_entry',
    "SELECT m.product_uom_qty FROM stock_move m JOIN stock_picking_type t ON t.id = m.picking_type_id WHERE t.code = 'incoming'",
    'SELECT p.name FROM public.res_partner p',
    'SELECT extract(epoch FROM (b.date_end - b.date_start)) / 3600 FROM packing_plant_stoppage_entry b',
    "SELECT substring(name from 1 for 3) FROM product_template",
    "SELECT x.value FROM stock_quant q CROSS JOIN LATERAL jsonb_array_elements('[1]'::jsonb) x(value)",
    `WITH day AS (SELECT date FROM crusher_production_entry), tot AS (SELECT count(*) FROM day)
       SELECT * FROM tot`,
  ].forEach(allowed);
});

test('a WITH name that shadows a forbidden table reads the CTE, not the table', () => {
  allowed('WITH mail_message AS (SELECT 1 AS id) SELECT * FROM mail_message');
  refused('WITH x AS (SELECT 1) SELECT * FROM mail_message');
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

test('checks the allowlist before the configuration, so a secret query never even queues', async () => {
  const saved = process.env.ODOO_PG_HOST;
  process.env.ODOO_PG_HOST = '127.0.0.1';
  process.env.ODOO_PG_USER = process.env.ODOO_PG_USER || 'x';
  process.env.ODOO_PG_DATABASE = process.env.ODOO_PG_DATABASE || 'x';
  try {
    await assert.rejects(odooDb.query('SELECT * FROM res_users'), err => err.code === 'ODOO_DB_FORBIDDEN');
  } finally {
    if (saved === undefined) delete process.env.ODOO_PG_HOST; else process.env.ODOO_PG_HOST = saved;
    await odooDb.close();
  }
});

test('the pinned certificate is committed, self-signed and the one this module pins', () => {
  const pem = fs.readFileSync(path.join(__dirname, '..', 'config', 'odoo-db-server.pem'), 'utf8');
  const cert = new crypto.X509Certificate(pem);
  assert.equal(cert.subject, cert.issuer, 'self-signed, as the Odoo database server presents it');
  assert.match(cert.subject, /CN=ubuntu-s-4vcpu-8gb-intel-lon1-01/);
  assert.ok(new Date(cert.validTo) > new Date(), 'the pinned certificate has not expired');
  assert.equal(cert.fingerprint256,
    'AC:25:56:87:EB:93:7E:0B:06:8D:8A:0E:21:FD:A7:B3:AA:23:7B:09:5F:71:76:70:09:46:C7:E7:DD:5B:ED:F1');
});
