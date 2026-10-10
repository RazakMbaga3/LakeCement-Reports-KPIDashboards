#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   ACCESSIBILITY AUDIT — WCAG 2.2 AA
   ──────────────────────────────────────────────────────────────────────
   Runs axe-core over every significant page, signed in, at a phone and a
   desktop viewport, and reports violations grouped by rule so a single
   root cause shows up once rather than 400 times.

     node e2e/a11y-audit.js                # audit, print, exit 1 on serious+
     node e2e/a11y-audit.js --all          # include minor/moderate detail
     node e2e/a11y-audit.js --json <file>  # machine-readable result

   Requires both servers up and the e2e_* accounts (global-setup.js).

   Why axe-core rather than hand-rolled checks: contrast in particular is
   not a thing to eyeball or to approximate. Resolving the *effective*
   background behind a label means walking the stacking context through
   transparency, gradients and overlapping elements, and axe already does
   that correctly. Rolling our own would mean inventing a slightly wrong
   version of a solved problem.

   Scope note: axe finds what is machine-checkable — roughly a third to a
   half of WCAG. It cannot tell whether alt text is *accurate*, whether a
   heading structure is *meaningful*, or whether colour is the *only*
   thing carrying an operational signal. Those stay a review job; the
   design system's rules (status colour always ships with a label or an
   icon) are the standing answer to the last one.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const AXE  = require.resolve('axe-core/axe.min.js');
const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const USER = process.env.AUDIT_USER || 'e2e_admin';
const PASS = process.env.AUDIT_PASS || 'E2E@Harness2026!';

const argAll  = process.argv.includes('--all');
const argJson = (() => { const i = process.argv.indexOf('--json'); return i > -1 ? process.argv[i + 1] : null; })();

const VIEWPORTS = [
  { name: 'phone',   width: 390,  height: 844,  mobile: true  },
  { name: 'desktop', width: 1440, height: 900,  mobile: false },
];

const PAGES = [
  ['dispatch',       'dispatch.html'],
  ['production',     'production.html'],
  ['power-plant',    'power-plant.html'],
  ['power-plant-rpt', 'power-plant-report.html'],
  ['kpi-dashboard',  'index.html'],
  ['home',           'portal.html'],
  ['mis',            'mis.html'],
  ['daily-report',   'daily-report.html'],
  ['analytics',      'analytics.html'],
  ['sales',          'sales.html'],
  ['purchases',      'purchases.html'],
  ['reliability',    'reliability.html'],
  ['approvals',      'approvals.html'],
  ['corrections',    'corrections.html'],
  ['quarry',         'mines-report.html'],
  ['balance',        'balance.html'],
  ['insights',       'insights.html'],
  ['completeness',   'completeness.html'],
  ['form-index',     'forms/index.html'],
  ['form-dispatch',  'forms/dispatch-form.html'],
  ['form-quality',   'forms/quality-form.html'],
  ['form-stoppage',  'forms/stoppage-form.html'],
  ['form-power',     'forms/power-form.html'],
  ['form-pile-quality', 'forms/pile-quality-form.html'],
];

/* The login page is audited signed OUT — it is the one screen every user
   meets before they have an account context. */
const SIGNED_OUT = [['login', 'login.html']];

const RANK = { critical: 4, serious: 3, moderate: 2, minor: 1 };

(async () => {
  const browser = await chromium.launch();
  const findings = [];   /* one row per rule × page × viewport */

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    const page = await ctx.newPage();

    /* Signed-out pages first, before a session exists. */
    for (const [label, url] of SIGNED_OUT) {
      await run(page, vp, label, url);
    }

    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
    await page.waitForTimeout(1200);

    if (/login\.html/.test(page.url())) {
      console.error(`\nCannot sign in as ${USER}. Re-create the harness accounts:\n` +
                    `    cd e2e && node -e "require('./global-setup.js')()"\n`);
      await browser.close();
      process.exit(2);
    }

    for (const [label, url] of PAGES) {
      await run(page, vp, label, url);
    }
    await ctx.close();
  }
  await browser.close();

  async function run(page, vp, label, url) {
    try {
      await page.goto(BASE + '/' + url, { waitUntil: 'networkidle', timeout: 30000 });
    } catch (_) { /* a slow API must not abort the audit */ }
    await page.waitForTimeout(1500);

    await page.addScriptTag({ path: AXE });
    const res = await page.evaluate(async () => {
      /* WCAG 2.2 AA is the standard the dashboard is held to. */
      return await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        resultTypes: ['violations'],
      });
    }).catch(e => ({ violations: [], _error: String(e && e.message) }));

    (res.violations || []).forEach(v => {
      findings.push({
        viewport: vp.name, page: label, url,
        id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
        count: v.nodes.length,
        samples: v.nodes.slice(0, 3).map(n => ({
          target: (n.target || []).join(' '),
          summary: (n.failureSummary || '').split('\n').filter(Boolean).slice(1, 3).join(' | '),
        })),
      });
    });

    const worst = (res.violations || []).reduce((m, v) => Math.max(m, RANK[v.impact] || 0), 0);
    const mark = worst >= 3 ? 'FAIL' : (worst ? 'warn' : ' ok ');
    console.log(`[${mark}] ${vp.name.padEnd(7)} ${label.padEnd(14)} ` +
                `${(res.violations || []).length} rule(s), ` +
                `${(res.violations || []).reduce((s, v) => s + v.nodes.length, 0)} node(s)` +
                (res._error ? '  ERROR ' + res._error : ''));
  }

  /* ── Group by rule: one root cause, reported once ─────────────────── */
  const byRule = {};
  findings.forEach(f => {
    const r = byRule[f.id] || (byRule[f.id] = {
      id: f.id, impact: f.impact, help: f.help, helpUrl: f.helpUrl,
      nodes: 0, pages: new Set(), viewports: new Set(), samples: [],
    });
    r.nodes += f.count;
    r.pages.add(f.page);
    r.viewports.add(f.viewport);
    if (r.samples.length < 4) r.samples.push(...f.samples.slice(0, 2));
  });

  const rules = Object.values(byRule)
    .sort((a, b) => (RANK[b.impact] || 0) - (RANK[a.impact] || 0) || b.nodes - a.nodes);

  console.log('\n' + '═'.repeat(78));
  console.log('VIOLATIONS BY RULE');
  console.log('═'.repeat(78));
  if (!rules.length) console.log('none');

  rules.forEach(r => {
    if (!argAll && (RANK[r.impact] || 0) < 2) return;
    console.log(`\n[${String(r.impact).toUpperCase()}] ${r.id} — ${r.nodes} node(s) on ` +
                `${r.pages.size} page(s) [${[...r.viewports].join(', ')}]`);
    console.log(`  ${r.help}`);
    console.log(`  pages: ${[...r.pages].slice(0, 8).join(', ')}${r.pages.size > 8 ? ' …' : ''}`);
    r.samples.slice(0, 3).forEach(s => {
      console.log(`    · ${s.target}`);
      if (s.summary) console.log(`      ${s.summary.slice(0, 150)}`);
    });
    console.log(`  ${r.helpUrl}`);
  });

  const serious = rules.filter(r => (RANK[r.impact] || 0) >= 3);
  const totalNodes = rules.reduce((s, r) => s + r.nodes, 0);

  console.log('\n' + '═'.repeat(78));
  console.log(`${rules.length} distinct rule(s), ${totalNodes} node(s) total; ` +
              `${serious.length} at serious or critical impact`);

  if (argJson) {
    fs.writeFileSync(argJson, JSON.stringify({
      generated: new Date().toISOString(),
      rules: rules.map(r => ({ ...r, pages: [...r.pages], viewports: [...r.viewports] })),
      findings,
    }, null, 2));
    console.log('JSON written to ' + argJson);
  }

  console.log('');
  if (serious.length) {
    console.log(`✗ ${serious.length} rule(s) at serious+ impact`);
    process.exit(1);
  }
  console.log('✓ no serious or critical accessibility violations');
})();
