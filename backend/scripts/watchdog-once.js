/*
  scripts/watchdog-once.js — run the watchdog a single time and print the
  result. Used by ops (npm run watchdog), scheduled task fallbacks, and
  the Phase 6 acceptance test (which points it at a dead DB to prove the
  health-down alert still emails).

  Output: one line starting with WATCHDOG_RESULT followed by JSON.
*/

require('../config/env');
const { runWatchdog } = require('../services/watchdog');

(async () => {
  try {
    const result = await runWatchdog({ date: process.argv[2] });
    console.log('WATCHDOG_RESULT ' + JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error('WATCHDOG_FAILED ' + err.message);
    process.exit(1);
  }
})();
