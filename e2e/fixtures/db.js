/*
  Direct Postgres access for the harness — used ONLY to set up and verify
  fixtures, never to shortcut the app. A test asserts through the UI and the
  API; it uses this pool to prove the row really landed in kpi_monthly.

  Reads backend/.env so there is exactly one place the DB credentials live.
*/
const path = require('path');
/* pg and dotenv are resolved out of backend/node_modules rather than
   duplicated here: the harness must talk to the SAME driver version the app
   uses (the DATE type-parser override below depends on it), and keeping
   e2e/package.json to a single dependency keeps `npm i` fast. */
const pg = require('../../backend/node_modules/pg');
const { Pool } = pg;

require('../../backend/node_modules/dotenv')
  .config({ path: path.resolve(__dirname, '../../backend/.env'), quiet: true });

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

/* daily_reports.record_date / kpi_monthly comparisons all happen as
   'YYYY-MM-DD' strings on the frontend; mirror backend/db/index.js's DATE
   parser override so the harness never sees a timezone-shifted Date. */
pg.types.setTypeParser(1082, v => v);

module.exports = { pool, query: (sql, params) => pool.query(sql, params) };
