/*
  scripts/compliance-reminders-once.js — run the Compliance Master reminder
  job once, by hand (the same code the 07:00 / 14:00 cron runs).

    npm run compliance:remind                     real run: roll periods
                                                  forward, write the day's
                                                  snapshot, send what is due
    npm run compliance:remind -- --dry-run        plan only: who WOULD be
                                                  emailed; writes no reminder
    npm run compliance:remind -- --dry-run --as-of 2026-11-01
                                                  …as if it were that day

  Whether anything is actually emailed is still the in-app master switch
  (Compliance Master → Settings), which starts OFF.
*/
require('../config/env');
const db = require('../db');
const { runReminders } = require('../services/complianceReminders');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const i = args.indexOf('--as-of');
const asOf = i >= 0 ? args[i + 1] : null;

runReminders({ dryRun, asOf, trigger: 'manual' })
  .then((r) => {
    console.log(JSON.stringify({ ok: r.ok, durationMs: r.durationMs, heapDeltaKb: r.heapDeltaKb, stats: r.stats }, null, 2));
    if (dryRun && r.preview) {
      console.log(`\nWould email ${r.preview.length} people:`);
      for (const p of r.preview) console.log(`  ${p.name || ''} <${p.email}> — ${p.items.length} item(s): ${p.items.map(x => `${x.title} [${x.stage}]`).join('; ').slice(0, 200)}`);
    }
  })
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.end());
