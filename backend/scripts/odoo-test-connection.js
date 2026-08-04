/*
  scripts/odoo-test-connection.js — verify Odoo credentials work, and (once
  they do) discover model/field names ourselves instead of waiting on the
  Odoo team to answer every field question by email.

  Usage:
    npm run odoo:test                                    → version + login check
    npm run odoo:test -- <model>                          → list that model's fields
    npm run odoo:test -- <model> --sample                 → + 3 sample records

  Example, once "Production Entry Raw Meal"'s real model name is confirmed:
    npm run odoo:test -- mrp.production --sample
*/

require('dotenv').config();
const odoo = require('../services/odooClient');

(async () => {
  try {
    console.log('→ Odoo server:', JSON.stringify(await odoo.version()));

    const uid = await odoo.authenticate();
    console.log(`→ Authenticated as uid ${uid}`);

    const model = process.argv[2];
    if (!model) {
      console.log('\nConnection OK. Pass a model name to list its fields, e.g.:');
      console.log('  npm run odoo:test -- mrp.production');
      return;
    }

    const fields = await odoo.fieldsGet(model);
    const names = Object.keys(fields).sort();
    console.log(`\n${model} — ${names.length} fields:`);
    for (const name of names) {
      const f = fields[name];
      console.log(`  ${name.padEnd(35)} ${(f.type || '?').padEnd(12)} ${f.string || ''}`);
    }

    if (process.argv.includes('--sample')) {
      const rows = await odoo.searchRead(model, [], [], { limit: 3 });
      console.log(`\n${rows.length} sample record(s):`);
      console.log(JSON.stringify(rows, null, 2));
    }
  } catch (err) {
    console.error('ODOO_TEST_FAILED:', err.message);
    process.exit(1);
  }
})();
