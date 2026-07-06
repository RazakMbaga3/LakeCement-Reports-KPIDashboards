/*
  services/logger.js — structured logging (pino).

  Two sinks: JSON lines to stdout (dev console / service manager capture)
  and daily-rotated files under backend/logs/ kept for 14 days (pino-roll).
  LOG_LEVEL in .env (default 'info').
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
        extension: '.log',
        limit: { count: 14 },   // keep two weeks of daily files
        mkdir: true,
      },
    },
    { target: 'pino/file', level, options: { destination: 1 } }, // stdout
  ],
});

module.exports = pino({ level, base: { app: 'lcl-mis' } }, transport);
