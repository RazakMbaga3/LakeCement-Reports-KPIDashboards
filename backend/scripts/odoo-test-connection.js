/*
  scripts/odoo-test-connection.js — report the real state of every Odoo
  connector this app has, and (for the generic External API only) discover
  model/field names ourselves instead of waiting on the Odoo team to answer
  every field question by email.

  Why this is per-connector: the app has FOUR independent Odoo connections,
  not one. The generic External API (ODOO_URL/ODOO_DB/ODOO_USERNAME/
  ODOO_API_KEY, services/odooClient.js) was never wired up to any pull, while
  the three bespoke REST connectors — dispatch, mining, dashboard — are
  configured and in daily use. This script used to test only the generic one
  and exit 1, which read as "the Odoo integration is dead" when three
  connectors were live (RAID I-6). The per-connector rules come from
  services/health.js's checkOdoo() — the same view GET /api/health serves —
  imported rather than restated so the two can't drift.

  Usage:
    npm run odoo:test                      → per-connector configuration report
    npm run odoo:test -- --live            → + a real 1-day call to dispatch & mining
    npm run odoo:test -- <model>           → generic API: list that model's fields
    npm run odoo:test -- <model> --sample  → + 3 sample records

  Exit codes (this is a candidate CI gate):
    0 — at least one connector is configured, and every check actually
        requested succeeded. The generic connector being unconfigured is
        NOT a failure: nothing depends on it.
    1 — no Odoo connector is configured at all, or a check you explicitly
        asked for failed (a --live probe, or generic model introspection).

  Never prints URLs or API keys: a connector is reported by name and status
  only, and any error text is scrubbed through redact() below before output.
*/

require('../config/env');
const odoo = require('../services/odooClient');
const { checkOdoo } = require('../services/health');

/* Error messages from fetch/undici can carry the host, and a misconfigured
   endpoint could echo the key back. Strip both before anything is printed. */
function redact(text) {
  let out = String(text).replace(/https?:\/\/\S+/gi, '<endpoint redacted>');
  for (const name of ['ODOO_API_KEY', 'ODOO_DISPATCH_API_KEY', 'ODOO_DASHBOARD_API_KEY', 'ODOO_MINING_API_KEY']) {
    const val = process.env[name];
    if (val && val.length >= 4) out = out.split(val).join('<key redacted>');
  }
  return out;
}

const USE = {
  generic:   'generic External API (JSON-RPC) — no pulls wired up to it',
  dispatch:  'dispatch_report — daily despatch tonnes pull',
  mining:    'mining_report — quarry weighbridge ticket pull',
  dashboard: 'sale/purchase_dashboard_report — Sales & Purchases pages, read on demand',
};

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

/* One real call per fast connector, over a 1-day range. Proves reachability
   and that the key is accepted; row count is informational only (the test
   instance is a dated snapshot, so zero rows is not a failure).
   The dashboard endpoints are deliberately NOT probed: they take ~5-30s per
   month of data with a 180s timeout (see odooDashboardClient.js), which is
   too slow and too flaky to belong in a connectivity check. */
async function liveProbe() {
  const from = isoDaysAgo(2), to = isoDaysAgo(1);
  const probes = [
    { name: 'dispatch', run: () => require('../services/odooDispatchClient').fetchDispatchReport(from, to) },
    { name: 'mining',   run: () => require('../services/odooMiningClient').fetchMiningReport(from, to) },
  ];

  console.log(`\nLive probe (${from}..${to}):`);
  let allOk = true;
  for (const p of probes) {
    try {
      const rows = await p.run();
      console.log(`  ${p.name.padEnd(10)} reachable, key accepted — ${rows.length} row(s)`);
    } catch (err) {
      allOk = false;
      console.log(`  ${p.name.padEnd(10)} FAILED — ${redact(err.message)}`);
    }
  }
  return allOk;
}

async function genericIntrospect(model) {
  console.log(`\n→ Odoo server: ${JSON.stringify(await odoo.version())}`);
  console.log(`→ Authenticated as uid ${await odoo.authenticate()}`);

  const fields = await odoo.fieldsGet(model);
  const names = Object.keys(fields).sort();
  console.log(`\n${model} — ${names.length} fields:`);
  for (const name of names) {
    const f = fields[name];
    console.log(`  ${name.padEnd(35)} ${(f.type || '?').padEnd(12)} ${f.string || ''}`);
  }

  if (process.argv.includes('--sample')) {
    const rows = await odoo.searchRead(model, [], [], { limit: 3 });
    console.log(`\n${rows.length} sample record(s):`);
    console.log(JSON.stringify(rows, null, 2));
  }
}

(async () => {
  const status = checkOdoo();
  const perConnector = status === 'not_configured'
    ? { generic: 'not_configured', dispatch: 'not_configured', mining: 'not_configured', dashboard: 'not_configured' }
    : status;

  console.log('Odoo connectors (configuration state, from services/health.js):');
  for (const key of ['generic', 'dispatch', 'mining', 'dashboard']) {
    const configured = perConnector[key] !== 'not_configured';
    console.log(`  ${(configured ? '[configured]' : '[not set]').padEnd(12)} ${key.padEnd(10)} ${USE[key]}`);
  }

  if (status === 'not_configured') {
    console.error('\nODOO_TEST_FAILED: no Odoo connector is configured — see backend/.env.example');
    process.exit(1);
  }

  const configuredCount = ['generic', 'dispatch', 'mining', 'dashboard']
    .filter((k) => perConnector[k] !== 'not_configured').length;
  console.log(`\n${configuredCount} of 4 connectors configured. The generic connector is unused by design; `
    + 'its absence is not a failure.');

  let ok = true;
  if (process.argv.includes('--live')) ok = await liveProbe();

  const model = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
  if (model) {
    if (perConnector.generic === 'not_configured') {
      console.error(`\nODOO_TEST_FAILED: listing fields of "${model}" needs the generic External API `
        + '— set ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY in .env');
      process.exit(1);
    }
    try {
      await genericIntrospect(model);
    } catch (err) {
      console.error('\nODOO_TEST_FAILED:', redact(err.message));
      process.exit(1);
    }
  } else if (perConnector.generic !== 'not_configured') {
    console.log('\nPass a model name to inspect the generic API, e.g.: npm run odoo:test -- mrp.production');
  }

  if (!ok) process.exit(1);
})();
