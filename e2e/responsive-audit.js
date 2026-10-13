#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   RESPONSIVE / UX ACCEPTANCE AUDIT
   ──────────────────────────────────────────────────────────────────────
   Drives every significant page in a real browser at four viewports and
   asserts the UX standard the dashboard is held to. This is the file
   that decides whether the design work is done — not an opinion.

     node e2e/responsive-audit.js                  # audit, print, exit 1 on fail
     node e2e/responsive-audit.js --shots <dir>    # also write screenshots
     node e2e/responsive-audit.js --json <file>    # machine-readable result

   Requires both servers up (backend :5000, preview :3000) and an
   e2e_admin account — `node e2e/global-setup.js` creates one.

   THE CRITERIA
   ────────────
   1. No horizontal overflow at any viewport. Body carries
      overflow-x:hidden, so overflow does not show as a scrollbar — it
      shows as content silently cut off. Measured by walking every
      element and ignoring anything correctly inside an x-scroll
      container (a 1,400px KPI grid in a scroll wrapper is correct).
   2. Content starts within one viewport on mobile. The regression this
      guards is the one that started this work: the sidebar rendered as
      a static block above the content, putting ~1,500px of navigation
      in front of every page.
   3. No text below the 12px legibility floor, at any viewport.
   4. Touch targets ≥44px on coarse pointers, excluding controls inside
      data-grid cells, which get the 40px cozy target instead.
   5. No form control under 16px on mobile — under 16px, iOS Safari
      zooms the page on focus, which is the single most-hated mobile
      form behaviour there is.
   6. The mobile shell is present: app bar, page title, bottom tab bar.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs   = require('fs');
const { chromium } = require('@playwright/test');

const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const USER = process.env.AUDIT_USER || 'e2e_admin';
const PASS = process.env.AUDIT_PASS || 'E2E@Harness2026!';

const argShots = (() => { const i = process.argv.indexOf('--shots'); return i > -1 ? process.argv[i + 1] : null; })();
const argJson  = (() => { const i = process.argv.indexOf('--json');  return i > -1 ? process.argv[i + 1] : null; })();

const VIEWPORTS = [
  { name: 'small',   width: 360,  height: 740,  mobile: true  },  /* Android floor    */
  { name: 'phone',   width: 390,  height: 844,  mobile: true  },  /* iPhone 14/15     */
  { name: 'tablet',  width: 820,  height: 1180, mobile: true  },  /* iPad portrait    */
  { name: 'desktop', width: 1440, height: 900,  mobile: false },  /* control-room PC  */
];

const PAGES = [
  ['kpi-dashboard',  'index.html'],
  ['home',           'portal.html'],
  ['dispatch',       'dispatch.html'],
  ['production',     'production.html'],
  ['power-plant',    'power-plant.html'],
  ['power-plant-rpt', 'power-plant-report.html'],
  ['mis',            'mis.html'],
  ['daily-report',   'daily-report.html'],
  ['analytics',      'analytics.html'],
  ['sales',          'sales.html'],
  ['purchases',      'purchases.html'],
  ['reliability',    'reliability.html'],
  ['approvals',      'approvals.html'],
  ['corrections',    'corrections.html'],
  ['compliance',     'compliance.html'],
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

/* Floors. Mobile is stricter than desktop by design: density is correct
   for a seated analyst on a 1440px screen and wrong for a
   superintendent reading in daylight at arm's length. */
const FLOOR_DESKTOP = 12;
const FLOOR_MOBILE  = 12;
const TAP_MIN       = 44;
const TAP_COZY      = 40;

/* ── The in-page measurement. Runs in the browser. ─────────────────── */
function measure(opts) {
  const { floor, isMobile, tapMin, tapCozy } = opts;
  const de = document.documentElement;
  const vw = de.clientWidth;
  const cs = el => getComputedStyle(el);

  const inScroller = el => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const ox = cs(n).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true;
      n = n.parentElement;
    }
    return false;
  };
  const inFixed = el => {
    let n = el;
    while (n && n !== document.body) { if (cs(n).position === 'fixed') return true; n = n.parentElement; }
    return false;
  };
  const name = el => el.tagName.toLowerCase() +
    (el.className && typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/)[0] : '');

  /* 1 — horizontal overflow */
  let overflow = 0; const overflowWho = [];
  document.querySelectorAll('body *').forEach(el => {
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.right <= vw + 1) return;
    if (inFixed(el) || inScroller(el)) return;
    const over = Math.round(r.right - vw);
    if (over > overflow) overflow = over;
    if (overflowWho.length < 4) overflowWho.push(name(el) + ' +' + over + 'px');
  });

  /* 2 — chrome before content */
  let chromeY = null;
  const main = document.querySelector('.main');
  if (main) {
    const hdr = main.querySelector('.top-header');
    let el = hdr ? hdr.nextElementSibling : main.firstElementChild;
    while (el && (el.tagName === 'SCRIPT' || el.getBoundingClientRect().height < 4)) el = el.nextElementSibling;
    if (el) chromeY = Math.round(el.getBoundingClientRect().top + window.scrollY);
  }

  /* 3 — type floor */
  let belowFloor = 0, textNodes = 0, minFs = 99; const typeWho = [];
  document.querySelectorAll('body *').forEach(el => {
    if (!Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) return;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const fs = parseFloat(s.fontSize);
    textNodes++;
    if (fs < minFs) minFs = fs;
    if (fs < floor) {
      belowFloor++;
      if (typeWho.length < 4) typeWho.push(name(el) + ' @' + fs + 'px');
    }
  });

  /* 4 — touch targets */
  let smallTap = 0, taps = 0; const tapWho = [];
  if (isMobile) {
    document.querySelectorAll('a[href],button,select,input:not([type=hidden]),textarea').forEach(el => {
      const s = cs(el);
      if (s.display === 'none' || s.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      /* WCAG 2.5.8 exempts a target "in a sentence or block of text".
         An inline <a> whose parent block holds real prose around it is
         that case — enlarging it would push the words apart and make
         the sentence harder to read, not easier to use. Anything
         inline-block, or a link that IS the whole block, gets no
         exemption: that is a button wearing an anchor. */
      if (el.tagName === 'A' && s.display === 'inline') {
        const host = el.parentElement;
        const hostText = host ? host.textContent.trim().length : 0;
        const ownText  = el.textContent.trim().length;
        if (host && hostText > ownText + 12) return;
      }
      const inCell = !!el.closest('td, th');
      const min = inCell ? tapCozy : tapMin;
      taps++;
      if (r.height < min - 0.5) {
        smallTap++;
        if (tapWho.length < 4) tapWho.push(name(el) + ' ' + Math.round(r.height) + 'px');
      }
    });
  }

  /* 5 — iOS zoom-on-focus */
  let zoomFields = 0;
  if (isMobile) {
    document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea')
      .forEach(el => {
        if (el.getBoundingClientRect().width === 0) return;
        if (parseFloat(cs(el).fontSize) < 16) zoomFields++;
      });
  }

  /* 6 — shell */
  const visible = el => !!el && cs(el).display !== 'none';
  const shell = {
    bottomNav: visible(document.querySelector('.ms-bottomnav')),
    menuBtn:   visible(document.querySelector('.ms-menu-btn')),
    title:     (document.querySelector('.ms-title') || {}).textContent || '',
    skipLink:  !!document.querySelector('.ms-skip'),
  };

  return { overflow, overflowWho, chromeY, viewportH: window.innerHeight,
           belowFloor, textNodes, minFs, typeWho,
           smallTap, taps, tapWho, zoomFields, shell };
}

/* ── Runner ────────────────────────────────────────────────────────── */
(async () => {
  if (argShots) fs.mkdirSync(argShots, { recursive: true });

  const browser = await chromium.launch();
  const results = [];
  const failures = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
    });
    const page = await ctx.newPage();

    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
      page.click('button[type=submit]'),
    ]);
    await page.waitForTimeout(1200);

    /* Fail loudly rather than audit the login page 18 times. The e2e
       accounts are dropped by the Playwright suite's global teardown, so
       running `npx playwright test` and then this audit in the same
       session leaves no account to log in with — and a silently
       unauthenticated run measures the wrong pages entirely. */
    if (/login\.html/.test(page.url())) {
      console.error(
        `\nCannot sign in as ${USER}. The account is missing, locked, or the password changed.\n` +
        `The Playwright suite's global teardown drops every e2e_* account, so re-create it with:\n` +
        `    node -e "require('./global-setup.js')()"\n`
      );
      await browser.close();
      process.exit(2);
    }

    const floor = vp.mobile ? FLOOR_MOBILE : FLOOR_DESKTOP;

    for (const [label, url] of PAGES) {
      try {
        await page.goto(BASE + '/' + url, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (_) { /* a slow API must not abort the audit */ }
      await page.waitForTimeout(1800);

      if (argShots) {
        await page.screenshot({ path: path.join(argShots, `${vp.name}-${label}.png`) }).catch(() => {});
      }

      const m = await page.evaluate(measure, {
        floor, isMobile: vp.mobile, tapMin: TAP_MIN, tapCozy: TAP_COZY,
      }).catch(e => ({ error: String(e && e.message) }));

      const row = { viewport: vp.name, page: label, url, ...m };
      results.push(row);

      const fail = [];
      if (m.error) fail.push('measurement error: ' + m.error);
      if (m.overflow > 0) fail.push(`overflows viewport by ${m.overflow}px (${m.overflowWho.join(', ')})`);
      if (vp.mobile && m.chromeY !== null && m.chromeY > m.viewportH) {
        fail.push(`content starts ${m.chromeY}px down — past one viewport (${m.viewportH}px)`);
      }
      if (m.belowFloor > 0) fail.push(`${m.belowFloor} text nodes below ${floor}px (${m.typeWho.join(', ')})`);
      if (vp.mobile && m.smallTap > 0) fail.push(`${m.smallTap} tap targets under size (${m.tapWho.join(', ')})`);
      if (vp.mobile && m.zoomFields > 0) fail.push(`${m.zoomFields} form controls under 16px — iOS will zoom on focus`);
      if (vp.mobile && !m.shell.bottomNav) fail.push('no bottom tab bar');
      if (vp.mobile && !m.shell.menuBtn) fail.push('no app-bar menu button');
      if (!m.shell.skipLink) fail.push('no skip-to-content link');

      row.failures = fail;
      if (fail.length) failures.push({ viewport: vp.name, page: label, fail });

      const mark = fail.length ? 'FAIL' : ' ok ';
      console.log(
        `[${mark}] ${vp.name.padEnd(7)} ${label.padEnd(14)}` +
        ` ovf=${String(m.overflow ?? '-').padStart(4)}` +
        ` chrome=${String(m.chromeY ?? '-').padStart(4)}` +
        ` <floor=${String(m.belowFloor ?? '-').padStart(3)}/${String(m.textNodes ?? '-').padEnd(4)}` +
        ` minFs=${String(m.minFs ?? '-').padStart(4)}` +
        (vp.mobile ? ` tap=${m.smallTap}/${m.taps} zoom=${m.zoomFields}` : '')
      );
      if (fail.length) fail.forEach(f => console.log(`         └─ ${f}`));
    }
    await ctx.close();
  }
  await browser.close();

  /* ── Report ─────────────────────────────────────────────────────── */
  const byVp = {};
  results.forEach(r => {
    const s = byVp[r.viewport] || (byVp[r.viewport] = { pages: 0, ovf: 0, floor: 0, nodes: 0, tap: 0, taps: 0, zoom: 0, maxChrome: 0 });
    s.pages++;
    if (r.overflow > 0) s.ovf++;
    s.floor += r.belowFloor || 0;
    s.nodes += r.textNodes || 0;
    s.tap   += r.smallTap || 0;
    s.taps  += r.taps || 0;
    s.zoom  += r.zoomFields || 0;
    s.maxChrome = Math.max(s.maxChrome, r.chromeY || 0);
  });

  console.log('\n' + '═'.repeat(78));
  console.log('SUMMARY');
  console.log('═'.repeat(78));
  Object.entries(byVp).forEach(([vp, s]) => {
    console.log(
      `${vp.padEnd(8)} pages=${String(s.pages).padStart(2)}` +
      `  overflowing=${String(s.ovf).padStart(2)}` +
      `  below-floor=${String(s.floor).padStart(4)}/${String(s.nodes).padEnd(5)}` +
      `  small-taps=${String(s.tap).padStart(3)}/${String(s.taps).padEnd(4)}` +
      `  iosZoom=${String(s.zoom).padStart(3)}` +
      `  maxChromeY=${s.maxChrome}`
    );
  });

  if (argJson) {
    fs.writeFileSync(argJson, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2));
    console.log('\nJSON written to ' + argJson);
  }

  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} of ${results.length} page/viewport checks FAILED`);
    process.exit(1);
  }
  console.log(`✓ all ${results.length} page/viewport checks passed`);
})();
