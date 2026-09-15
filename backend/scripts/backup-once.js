/*
  scripts/backup-once.js — run a database backup right now.
  Usage: npm run backup          (writes to BACKUP_DIR from .env)
*/

require('../config/env');
const { runBackup } = require('../services/backup');

runBackup()
  .then(r => {
    console.log(`✅ Backup written: ${r.file} (${(r.bytes / 1024).toFixed(1)} KB)`);
    if (r.pruned.length) console.log(`   Pruned ${r.pruned.length} old dump(s): ${r.pruned.join(', ')}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Backup failed:', err.message);
    process.exit(1);
  });
