/*
  scripts/rename-quarry-manager.js — one-time cosmetic patch for the
  "Mines" -> "Quarry" rename (see mines-report.html redesign).

  db/seed.js now seeds the 'mining' account with full_name 'Quarry Manager'
  / dept 'QUARRY', but seed.js only runs on a fresh database — this patches
  the row that's already live. username/role stay 'mining' (internal key,
  unrelated to the label change), so logins and permissions are unaffected.

  Idempotent — safe to run more than once.

  Usage: node scripts/rename-quarry-manager.js
*/
require('../config/env');
const db = require('../db');

async function main() {
  const result = await db.query(
    `UPDATE users SET full_name = 'Quarry Manager', department = 'QUARRY'
     WHERE username = 'mining' AND (full_name <> 'Quarry Manager' OR department <> 'QUARRY')
     RETURNING username, full_name, department`
  );
  if (result.rows.length) {
    console.log('Updated:', result.rows[0]);
  } else {
    console.log('No change needed (already renamed, or no "mining" user found).');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
