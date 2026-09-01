/*
  Regenerates test/fixtures/kpi-monthly-keys.json — the checked-in list of
  every (department, kpi_key) pair that actually holds data.

  backend/test/kpi-keys.test.js diffs index.html's row bindings against this
  snapshot with no DB connection, so `npm test` stays runnable anywhere. The
  snapshot going stale is the point: after a deliberate KPI rename or a new
  backfill, run this, review the diff, and commit it together with the
  index.html change that motivated it. An UNEXPLAINED diff here means data
  reached kpi_monthly under a key no dashboard row displays.

  Usage: npm run test:kpi-keys:snapshot
*/
const fs   = require('fs');
const path = require('path');
/* Resolve .env from backend/ regardless of the cwd this is invoked from — the
   snapshot is just as likely to be regenerated from the repo root as from
   backend/ during a rename. */
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const db   = require('../db');

const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'kpi-monthly-keys.json');

(async () => {
  const { rows } = await db.query(
    'SELECT DISTINCT department, kpi_key FROM kpi_monthly ORDER BY department, kpi_key'
  );
  const byDept = {};
  for (const r of rows) (byDept[r.department] = byDept[r.department] || []).push(r.kpi_key);

  const before = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const after  = JSON.stringify(byDept, null, 2) + '\n';
  fs.writeFileSync(OUT, after);

  console.log(`${Object.keys(byDept).length} departments, ${rows.length} keys → ${path.relative(process.cwd(), OUT)}`);
  console.log(before === after ? 'No change.' : 'Snapshot CHANGED — review the diff before committing.');
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
