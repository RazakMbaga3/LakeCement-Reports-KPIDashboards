/*
  config/env.js — the one place backend/.env gets loaded.

  dotenv@17 prints a randomly chosen advert on every successful load: see
  the TIPS array at node_modules/dotenv/lib/main.js:7, which includes
  third-party domains (vestauth.com among them) and is emitted unless
  `quiet: true` is passed. Forty-one files here called
  `require('dotenv').config()` directly, so a server boot, a migration or a
  CI job sprayed marketing text nobody in this project wrote or reviewed
  through the console, the Windows service log and the Actions output —
  interleaved with the lines an operator is actually reading during a
  deploy. Suppressing it is one option flag; keeping that flag on 41
  separate call sites is 41 chances for the next one to forget. One module
  they all require is one (RAID I-11 / WBS-SEC-3).

  Requiring it for the side effect is the whole interface:

      require('../config/env');     // scripts/, db/, test/
      require('./config/env');      // server.js

  Node's module cache means the file is read once per process however many
  modules ask for it. It also returns process.env, so a caller that prefers
  `const env = require('../config/env')` gets something useful back.

  The path is pinned to backend/.env via __dirname rather than left to
  dotenv's default of process.cwd(). Several scripts here are documented as
  being run from the repo root — scripts/backfill-raw-materials.js says
  `node backend/scripts/backfill-raw-materials.js` in its own usage — and
  from there the cwd default finds no file, loads nothing, and silently
  leaves every DB_* on its fallback. Three scripts had already worked this
  out and pinned the path themselves (import-kpi-monthly-xlsx.js,
  import-stoppage-facts.js, snapshot-kpi-keys.js); this makes it the rule
  instead of a thing you have to rediscover. backend/.env is where both
  RUNBOOK.md §1 and the DigitalOcean deploy put the file.

  Nothing is overridden. A variable already present in the real environment
  — the droplet's service definition, a CI secret, a one-off
  `DB_NAME=x npm run migrate` — still beats the file, which is dotenv's
  default and exactly what every call site had before this module existed.
*/
const path = require('path');

require('dotenv').config({
  path:  path.join(__dirname, '..', '.env'),
  quiet: true,
});

module.exports = process.env;
