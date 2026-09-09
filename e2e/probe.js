/* Throwaway probe: answer one specific question about the live DOM.
   node probe.js <page-url-path> */
'use strict';
const { chromium } = require('@playwright/test');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
const URL  = process.argv[2] || 'forms/dispatch-form.html';
const W    = parseInt(process.argv[3] || '1440', 10);

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: W, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.fill('#username', 'e2e_admin'); await p.fill('#password', 'E2E@Harness2026!');
  await Promise.all([p.waitForNavigation().catch(()=>{}), p.click('button[type=submit]')]);
  await p.waitForTimeout(1000);
  await p.goto(BASE + '/' + URL, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(2000);

  const r = await p.evaluate(() => {
    const out = {};
    /* KPI value alignment */
    out.ktVals = [...document.querySelectorAll('.kt')].map(k => {
      const v = k.querySelector('.kt-val'); const l = k.querySelector('.kt-lbl');
      return {
        label: (l?.textContent || '').trim().slice(0, 28),
        labelH: l ? Math.round(l.getBoundingClientRect().height) : null,
        valY: v ? Math.round(v.getBoundingClientRect().top) : null,
        cls: k.className,
      };
    });
    /* Any element that scrolls horizontally in the top 200px */
    out.scrollers = [...document.querySelectorAll('body *')].filter(el => {
      const rc = el.getBoundingClientRect();
      return rc.top < 220 && el.scrollWidth > el.clientWidth + 2 && rc.height > 0;
    }).slice(0, 10).map(el => ({
      sig: el.tagName.toLowerCase() + '.' + (String(el.className).split(/\s+/)[0] || ''),
      y: Math.round(el.getBoundingClientRect().top),
      h: Math.round(el.getBoundingClientRect().height),
      sw: el.scrollWidth, cw: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
    }));
    /* Brand accent bar geometry */
    const bar = document.querySelector('.brand-accent-bar');
    if (bar) { const rc = bar.getBoundingClientRect();
      out.bar = { x: Math.round(rc.left), w: Math.round(rc.width), y: Math.round(rc.top),
                  h: Math.round(rc.height), bg: getComputedStyle(bar).backgroundImage.slice(0, 120) }; }
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await b.close();
})();
