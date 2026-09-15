/*
  services/logger.js — structured logging (pino).

  Two sinks: JSON lines to stdout (dev console / service manager capture)
  and dated files under backend/logs/ (pino-roll). LOG_LEVEL in .env
  (default 'info').

  This header used to promise "daily-rotated files kept for 14 days". It
  was not true, and the reason is worth writing down because the options
  read as though it should be (RAID I-13):

    • pino-roll's daily roll is a setTimeout to the next midnight
      (pino-roll.js:178) — it only fires while the process is up.
    • On startup it reopens the highest-numbered file *created in the
      current period*, and "created" means birthtime (lib/utils.js:180).
      After a restart on a later day nothing matches, so it falls back to
      index 1 and appends to whatever app.1.log already is.
    • The 14-file limit is applied as part of a roll (pino-roll.js:157),
      so if nothing ever rolls, nothing is ever pruned.

  This service restarts constantly — backend/logs/app.1.log accumulated 433
  boots across 42 days in one 26 MB file, first entry 2026-07-06, because
  every restart landed back on index 1. No roll, therefore no retention,
  therefore a file that only ever grew.

  Three options make the promise real:

    • dateFormat puts the date in the name (app.2026-09-14.1.log), so a
      restart on a new day opens a new file instead of appending to July's.
      Restarts on the same day still share that day's file, which is right.
    • size caps one file at 10 MB. Unbounded growth here is a slow disk
      fill on the droplet, and services/health.js does not complain until
      under 5 GB free — by which point the logs are the emergency.
    • limit.removeOtherLogFiles lets cleanup delete files left by earlier
      runs. Without it pino-roll prunes only files the current process
      created (lib/utils.js:205), which for a service restarted this often
      is almost nothing.

  Known and deliberately not worked around here: cleanup still only runs
  when a roll happens, so a process that restarts daily and never crosses
  midnight or 10 MB while up accumulates one modest file per day. Each file
  is bounded; the count is not. A prune-on-boot would close that, and is
  flagged for the backlog rather than bolted onto the logger.

  The existing app.1.log / app.2.log / app.3.log do not match the dated
  pattern, so pino-roll's cleanup ignores them (lib/utils.js:99) — they are
  safe from this change, and safe to delete by hand once nobody needs them
  as evidence for I-13.
*/

const pino = require('pino');
const path = require('path');

const level = process.env.LOG_LEVEL || 'info';

const transport = pino.transport({
  targets: [
    {
      target: 'pino-roll',
      level,
      options: {
        file: path.join(__dirname, '..', 'logs', 'app'),
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',   // app.2026-09-14.1.log — survives restarts
        extension: '.log',
        size: '10m',                // hard ceiling per file; rolls also trigger cleanup
        limit: { count: 14, removeOtherLogFiles: true },
        mkdir: true,
      },
    },
    { target: 'pino/file', level, options: { destination: 1 } }, // stdout
  ],
});

module.exports = pino({ level, base: { app: 'lcl-mis' } }, transport);
