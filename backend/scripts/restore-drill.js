/*
  scripts/restore-drill.js — CLI entry point for services/restoreDrill.js.

  Usage: npm run restore:drill             (newest dump in BACKUP_DIR)
         node scripts/restore-drill.js path\to\file.dump

  Also runs automatically on a monthly schedule (server.js, gated on
  RESTORE_DRILL_CRON) — this file is what scripts/accept-phase7.js spawns
  and parses, so its output contract (the RESTORE_DRILL_RESULT line, exit
  codes) must stay exactly as-is; the actual drill logic lives in
  services/restoreDrill.js.

  Output ends with one line: RESTORE_DRILL_RESULT {json}
*/

require('dotenv').config();
const { runRestoreDrill } = require('../services/restoreDrill');

(async () => {
  const dump = process.argv[2];
  const result = await runRestoreDrill(dump);
  console.log('RESTORE_DRILL_RESULT ' + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
})().catch(err => {
  console.error('❌ Restore drill failed:', err.message);
  console.log('RESTORE_DRILL_RESULT ' + JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
