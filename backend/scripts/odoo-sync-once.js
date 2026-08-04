/*
  scripts/odoo-sync-once.js — run the Odoo pull(s) a single time and print
  the result. Mirrors watchdog-once.js. Output: one line starting with
  ODOO_SYNC_RESULT followed by JSON.
*/

require('dotenv').config();
const { runOdooSync } = require('../services/odooSync');

(async () => {
  try {
    const result = await runOdooSync();
    console.log('ODOO_SYNC_RESULT ' + JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error('ODOO_SYNC_FAILED ' + err.message);
    process.exit(1);
  }
})();
