/*
  db/init.js — one-shot DB bootstrap for a fresh deploy target (e.g. Render).

  Applies schema.sql (all CREATE TABLE ... IF NOT EXISTS, safe to re-run)
  then runs the same migration logic as migrate.js. Intended to run as part
  of the platform's start command, ahead of `node server.js`, so a brand
  new Postgres instance ends up schema-complete with zero manual psql steps.

  Does NOT seed users — db/seed.js is destructive to any password a user
  has already changed (it resets must_change_password = true), so it stays
  a deliberate, one-time, manually-triggered step.
*/

require('../config/env');
const fs   = require('fs');
const path = require('path');
const db   = require('./index');

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(schema);
  console.log('✅ schema.sql applied (or already current)');

  const dir   = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const done  = new Set(
    (await db.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
  );

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;

    const sql    = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ applied ${file}`);
      applied++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`❌ ${file} failed (rolled back): ${err.message}`);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log(applied ? `Done — ${applied} migration(s) applied.` : 'Schema is current.');
  process.exit(0);
}

init().catch(err => {
  console.error('❌ db init failed:', err.message);
  process.exit(1);
});
