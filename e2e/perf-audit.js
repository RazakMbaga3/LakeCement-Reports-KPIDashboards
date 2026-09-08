#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   PERFORMANCE AUDIT — plant-site connection
   ──────────────────────────────────────────────────────────────────────
     node e2e/perf-audit.js               # throttled, print, exit 1 over budget
     node e2e/perf-audit.js --fast        # no throttling (local baseline)
     node e2e/perf-audit.js --json <file>

   Throttled by default to roughly what Kimbiji gets on a phone: 1.6 Mbps
   down, 750 Kbps up, 300ms RTT. Measuring on a LAN beside the server
   would say everything is instant and tell us nothing — the pages this
   has to serve are 125–260KB of HTML before a single row of data.

   What it reports, per page:
     · transfer   bytes actually over the wire, and the request count
     · html       the document alone, which is the part we control
     · FCP        first contentful paint — when something appears
     · LCP        largest contentful paint — when the main content is there
     · load       window load

   Budgets are set from measured reality, not aspiration, and are meant
   to ratchet down. See docs/DESIGN_SYSTEM.md.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const { chromium } = require('@playwright/test');

const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const USER = process.env.AUDIT_USER || 'e2e_admin';
const PASS = process.env.AUDIT_PASS || 'E2E@Harness2026!';

const FAST    = process.argv.includes('--fast');
const argJson = (() => { const i = process.argv.indexOf('--json'); return i > -1 ? process.argv[i + 1] : null; })();

/* Chrome DevTools "Fast 3G" — a fair stand-in for a plant handset. */
const THROTTLE = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput:   (750 * 1024) / 8,
  latency: 300,
};

/* Set just above measured reality so a regression trips them, and meant
   to ratchet DOWN as pages get lighter — a budget nothing can breach is
   not a budget. Worst page today: mis 257KB html, daily-report 870KB
   transfer / 2848ms FCP, login 4191ms load.

   These are measured WITHOUT compression, because preview-server.js does
   not gzip. Production nginx does (see deploy/nginx.digitalocean.conf),
   which takes roughly 75% off every text response — so real figures over
   the same connection are materially better than these. Holding the
   budget against the uncompressed numbers keeps the margin honest. */
const BUDGET = {
  htmlKB:    260,   /* the document alone                       */
  transferKB: 900,  /* everything, first visit, uncached        */
  requests:    40,
  fcpMs:     3200,
  loadMs:    6000,
};

const PAGES = [
  ['login',          'login.html'],
  ['home',           'portal.html'],
  ['kpi-dashboard',  'index.html'],
  ['mis',            'mis.html'],
  ['daily-report',   'daily-report.html'],
  ['analytics',      'analytics.html'],
  ['reliability',    'reliability.html'],
  ['quarry',         'mines-report.html'],
  ['form-quality',   'forms/quality-form.html'],
  ['form-dispatch',  'forms/dispatch-form.html'],
];

const kb = b => Math.round(b / 1024);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();

  /* Sign in unthrottled — the login round-trip is not what we measure. */
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.fill('#username', USER);
  await page.fill('#password', PASS);
  await Promise.all([
    page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
    page.click('button[type=submit]'),
  ]);
  await page.waitForTimeout(1000);
  if (/login\.html/.test(page.url())) {
    console.error(`\nCannot sign in as ${USER}. Re-create the harness accounts:\n` +
                  `    cd e2e && node -e "require('./global-setup.js')()"\n`);
    await browser.close();
    process.exit(2);
  }

  const cdp = await ctx.newCDPSession(page);
  if (!FAST) await cdp.send('Network.emulateNetworkConditions', THROTTLE);

  const rows = [];
  console.log(FAST ? 'Unthrottled (local baseline)\n' : 'Throttled: 1.6 Mbps / 750 Kbps / 300ms RTT\n');
  console.log('page            html   transfer  reqs    FCP     LCP    load');
  console.log('─'.repeat(66));

  for (const [label, url] of PAGES) {
    let transfer = 0, requests = 0, html = 0;
    const onResponse = async res => {
      requests++;
      try {
        const len = Number(res.headers()['content-length'] || 0);
        const body = len || (await res.body().catch(() => Buffer.alloc(0))).length;
        transfer += body;
        if (res.url().split('?')[0].endsWith('.html')) html += body;
      } catch (_) {}
    };
    page.on('response', onResponse);

    const t0 = Date.now();
    try {
      await page.goto(BASE + '/' + url, { waitUntil: 'load', timeout: 90000 });
    } catch (_) { /* a slow page is a finding, not a crash */ }
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(1200);

    const paint = await page.evaluate(() => {
      const out = { fcp: null, lcp: null };
      performance.getEntriesByType('paint').forEach(e => {
        if (e.name === 'first-contentful-paint') out.fcp = Math.round(e.startTime);
      });
      const lcps = performance.getEntriesByType('largest-contentful-paint');
      if (lcps.length) out.lcp = Math.round(lcps[lcps.length - 1].startTime);
      return out;
    }).catch(() => ({ fcp: null, lcp: null }));

    page.off('response', onResponse);

    const row = { page: label, url, htmlKB: kb(html), transferKB: kb(transfer),
                  requests, fcpMs: paint.fcp, lcpMs: paint.lcp, loadMs };
    const over = [];
    if (row.htmlKB     > BUDGET.htmlKB)     over.push(`html ${row.htmlKB}KB`);
    if (row.transferKB > BUDGET.transferKB) over.push(`transfer ${row.transferKB}KB`);
    if (row.requests   > BUDGET.requests)   over.push(`${row.requests} requests`);
    if (row.fcpMs && row.fcpMs > BUDGET.fcpMs) over.push(`FCP ${row.fcpMs}ms`);
    if (row.loadMs     > BUDGET.loadMs)     over.push(`load ${row.loadMs}ms`);
    row.over = over;
    rows.push(row);

    console.log(
      `${label.padEnd(15)}${String(row.htmlKB).padStart(4)}K ${String(row.transferKB).padStart(8)}K` +
      `${String(row.requests).padStart(6)} ${String(row.fcpMs ?? '-').padStart(6)}ms ` +
      `${String(row.lcpMs ?? '-').padStart(5)}ms ${String(row.loadMs).padStart(6)}ms` +
      (over.length ? '   OVER: ' + over.join(', ') : '')
    );
  }

  await browser.close();

  const worst = rows.filter(r => r.over.length);
  console.log('\n' + '═'.repeat(66));
  console.log(`budget: html ≤${BUDGET.htmlKB}KB · transfer ≤${BUDGET.transferKB}KB · ` +
              `≤${BUDGET.requests} reqs · FCP ≤${BUDGET.fcpMs}ms · load ≤${BUDGET.loadMs}ms`);
  const avg = k => Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length);
  console.log(`average: html ${avg('htmlKB')}KB · transfer ${avg('transferKB')}KB · ` +
              `${avg('requests')} reqs · FCP ${avg('fcpMs')}ms · load ${avg('loadMs')}ms`);

  if (argJson) {
    fs.writeFileSync(argJson, JSON.stringify({ generated: new Date().toISOString(), throttled: !FAST, budget: BUDGET, rows }, null, 2));
    console.log('JSON written to ' + argJson);
  }

  console.log('');
  if (worst.length) {
    console.log(`✗ ${worst.length} page(s) over budget`);
    process.exit(1);
  }
  console.log(`✓ all ${rows.length} pages within budget`);
})();
