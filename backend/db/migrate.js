/*
  db/migrate.js — dead-simple forward-only migration runner.

  Applies db/migrations/*.sql in filename order, recording each file in
  schema_migrations so it never runs twice. Each migration runs inside a
  transaction: it fully applies or fully rolls back.

  CONVENTION: schema.sql stays the canonical CURRENT state (used to create
  a fresh database); migrations upgrade existing databases. Because a fresh
  database may already include a migration's changes via schema.sql, every
  migration must be IDEMPOTENT (ADD COLUMN IF NOT EXISTS, etc.).

  Usage: npm run migrate
*/

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('./index');

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

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

  console.log(applied ? `Done — ${applied} migration(s) applied.` : 'Nothing to do — schema is current.');
  process.exit(0);
}

migrate();
