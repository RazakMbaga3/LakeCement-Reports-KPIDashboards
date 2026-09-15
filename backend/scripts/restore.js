/*
  scripts/restore.js — restore a dump into a NEW database.

  Deliberately never touches the live DB_NAME: it restores into the
  database name you give it, so you inspect the data first and then do
  the switchover consciously (procedure in docs/RUNBOOK.md).

  Usage: node scripts/restore.js <dumpfile> <new_database_name>
*/

require('../config/env');
const { Client } = require('pg');
const { spawn }  = require('child_process');
const { findPgTool } = require('../services/backup');

const [dump, target] = process.argv.slice(2);

if (!dump || !target) {
  console.error('Usage: node scripts/restore.js <dumpfile> <new_database_name>');
  process.exit(1);
}
if (target === process.env.DB_NAME) {
  console.error(`Refusing to restore directly over the live database (${target}).`);
  console.error('Restore into a new name, verify it, then follow the switchover steps in docs/RUNBOOK.md.');
  process.exit(1);
}

(async () => {
  // CREATE DATABASE needs CREATEDB rights — PG_ADMIN_* overrides when the
  // app user hasn't been granted them (see docs/RUNBOOK.md).
  const admin = new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT,
    user: process.env.PG_ADMIN_USER || process.env.DB_USER,
    password: process.env.PG_ADMIN_PASSWORD || process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${target.replace(/[^a-z0-9_]/gi, '')}`);
  await admin.end();

  const tool = findPgTool('pg_restore');
  const child = spawn(tool, [
    '--no-owner', '--no-privileges', '--no-password',
    '-h', process.env.DB_HOST || 'localhost',
    '-p', process.env.DB_PORT || '5432',
    '-U', process.env.DB_USER,
    '-d', target,
    dump,
  ], { env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD }, stdio: 'inherit' });

  child.on('exit', code => {
    if (code === 0) {
      console.log(`✅ Restored ${dump} into database "${target}".`);
      console.log('Verify the data, then follow docs/RUNBOOK.md → "Restoring from backup" for switchover.');
    } else {
      console.error('❌ pg_restore exited with code ' + code);
    }
    process.exit(code);
  });
})().catch(err => { console.error('❌ Restore failed:', err.message); process.exit(1); });
