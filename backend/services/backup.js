/*
  services/backup.js — nightly pg_dump with retention.

  runBackup() writes a custom-format dump (pg_restore-able) named
  lcl_mis-YYYY-MM-DD-HHmm.dump into BACKUP_DIR, then prunes dumps older
  than BACKUP_KEEP_DAYS (default 14). Scheduled in server.js on
  BACKUP_CRON (default 02:30) whenever BACKUP_DIR is set; run manually
  with `npm run backup`. Backup freshness is watched by services/health.js
  + the watchdog, so a silently failing backup becomes an email alert.

  pg tools are resolved from PG_BIN (.env), then PATH, then the standard
  and Odoo-bundled Windows install locations.
*/

const { spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

function findPgTool(tool) {
  const exe = process.platform === 'win32' ? tool + '.exe' : tool;

  if (process.env.PG_BIN) {
    const p = path.join(process.env.PG_BIN, exe);
    if (fs.existsSync(p)) return p;
    throw new Error(`PG_BIN is set but ${p} does not exist`);
  }

  if (spawnSync(tool, ['--version'], { shell: false }).status === 0) return tool;

  if (process.platform === 'win32') {
    const candidates = [];
    for (const pf of ['C:\\Program Files', 'C:\\Program Files (x86)']) {
      // standard installer: <pf>\PostgreSQL\<version>\bin
      const std = path.join(pf, 'PostgreSQL');
      if (fs.existsSync(std)) {
        for (const v of fs.readdirSync(std).sort().reverse()) {
          candidates.push(path.join(std, v, 'bin', exe));
        }
      }
      // Odoo bundle: <pf>\Odoo <version>\PostgreSQL\bin
      if (fs.existsSync(pf)) {
        for (const d of fs.readdirSync(pf).filter(n => n.toLowerCase().startsWith('odoo'))) {
          candidates.push(path.join(pf, d, 'PostgreSQL', 'bin', exe));
        }
      }
    }
    const hit = candidates.find(c => fs.existsSync(c));
    if (hit) return hit;
  }

  throw new Error(`${tool} not found — set PG_BIN in .env to your PostgreSQL bin directory`);
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function runBackup({ dir } = {}) {
  const backupDir = dir || process.env.BACKUP_DIR;
  if (!backupDir) throw new Error('BACKUP_DIR is not configured');
  fs.mkdirSync(backupDir, { recursive: true });

  const pgDump = findPgTool('pg_dump');
  const file   = path.join(backupDir, `lcl_mis-${stamp()}.dump`);

  await run(pgDump, [
    '--format=custom', '--no-password',
    '-h', process.env.DB_HOST || 'localhost',
    '-p', process.env.DB_PORT || '5432',
    '-U', process.env.DB_USER,
    '-f', file,
    process.env.DB_NAME,
  ], { PGPASSWORD: process.env.DB_PASSWORD });

  const bytes = fs.statSync(file).size;
  if (bytes < 1024) throw new Error(`backup file is suspiciously small (${bytes} bytes)`);

  // Retention: drop dumps older than BACKUP_KEEP_DAYS
  const keepDays = parseFloat(process.env.BACKUP_KEEP_DAYS || '14');
  const cutoff   = Date.now() - keepDays * 86400000;
  const pruned   = [];
  for (const f of fs.readdirSync(backupDir)) {
    if (!/^lcl_mis-.*\.dump$/.test(f)) continue;
    const full = path.join(backupDir, f);
    if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); pruned.push(f); }
  }

  return { file, bytes, pruned };
}

module.exports = { runBackup, findPgTool };
