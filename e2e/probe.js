/* Throwaway probe: run axe on one page and print colour-contrast nodes.
   node probe.js <page-path> [width] */
'use strict';
const fs = require('fs');
const { chromium } = require('@playwright/test');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
const URL  = process.argv[2] || 'daily-report.html';
const W    = parseInt(process.argv[3] || '1440', 10);
const AXE  = require.resolve('axe-core/axe.min.js');

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: W, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.fill('#username', 'e2e_admin'); await p.fill('#password', 'E2E@Harness2026!');
  await Promise.all([p.waitForNavigation().catch(()=>{}), p.click('button[type=submit]')]);
  await p.waitForTimeout(1000);
  await p.goto(BASE + '/' + URL, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(2800);
  await p.addScriptTag({ content: fs.readFileSync(AXE, 'utf8') });

  const res = await p.evaluate(async () => {
    const r = await window.axe.run(document, { runOnly: ['color-contrast'] });
    return r.violations.map(v => ({
      id: v.id, impact: v.impact,
      nodes: v.nodes.map(n => ({ target: n.target, msg: n.any.map(a => a.message) })),
    }));
  });
  console.log(JSON.stringify(res, null, 2));
  await b.close();
})();
