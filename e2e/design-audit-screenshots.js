/*
  ══════════════════════════════════════════════════════════════════════
  Design audit capture — the visual half of the audit.

  responsive-audit.js measures (overflow, type floor, tap targets). It
  cannot see whether a page LOOKS right: alignment, density, consistency,
  chart legibility. This script produces the pixels a reviewer judges.

  Frames, not full-page. A full-page PNG of a long page is 360×6000, and
  anything that later fits it to a screen or a model's input window
  squashes it until the text is unreadable. Capturing viewport-sized
  frames at successive scroll offsets keeps every image at the aspect
  ratio a human actually sees, so type stays legible.

  Device scale factor is inverse to viewport width for the same reason:
  a phone frame is upscaled 2× so its 12px type survives review, a
  1920 frame is captured 1:1 because it is already near the ceiling.

      node design-audit-screenshots.js --out design-audit/shots \
        [--pages a,b] [--viewports phone,desktop] [--frames 3] [--user e2e_admin]
  ══════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const fs   = require('fs');
const { chromium } = require('@playwright/test');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
const PASS = process.env.AUDIT_PASS || 'E2E@Harness2026!';

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const OUT       = arg('out', 'design-audit/shots');
const MAXFRAMES = parseInt(arg('frames', '3'), 10);
const USER      = arg('user', 'e2e_admin');

const ALL_VIEWPORTS = [
  { name: 'small',   width: 360,  height: 740,  mobile: true,  dsf: 2 },
  { name: 'phone',   width: 390,  height: 844,  mobile: true,  dsf: 2 },
  { name: 'tablet',  width: 820,  height: 1180, mobile: true,  dsf: 1 },
  { name: 'laptop',  width: 1280, height: 800,  mobile: false, dsf: 1 },
  { name: 'desktop', width: 1440, height: 900,  mobile: false, dsf: 1 },
  { name: 'wall',    width: 1920, height: 1080, mobile: false, dsf: 1 },
];

/* Every page a signed-in user reaches by daily use, plus the unauthenticated
   entry points. Order is roughly by traffic: a systemic defect found on the
   first few is usually a design-system fix that settles the rest. */
const ALL_PAGES = [
  ['portal',           'portal.html'],
  ['kpi-dashboard',    'index.html'],
  ['kpi-production',   'index.html?dept=production'],
  ['kpi-powerplant',   'index.html?dept=powerplant'],
  ['mis',              'mis.html'],
  /* The three split-report review pages. Their entry forms are listed
     separately (daily-report, form-dispatch, power-plant-rpt) — both
     halves need capturing, since each split moved content between them. */
  ['dispatch',         'dispatch.html'],
  ['production',       'production.html'],
  ['power-plant',      'power-plant.html'],
  ['daily-report',     'daily-report.html'],
  ['analytics',        'analytics.html'],
  ['approvals',        'approvals.html'],
  ['sales',            'sales.html'],
  ['purchases',        'purchases.html'],
  ['reliability',      'reliability.html'],
  ['quarry',           'mines-report.html'],
  ['balance',          'balance.html'],
  ['insights',         'insights.html'],
  ['completeness',     'completeness.html'],
  ['power-plant-rpt',  'power-plant-report.html'],
  ['reports-export',   'reports-export.html'],
  ['memory',           'memory.html'],
  ['monitor',          'monitor.html'],
  ['admin-users',      'admin-users.html'],
  ['coming-soon',      'coming-soon.html'],
  ['form-index',       'forms/index.html'],
  ['form-dispatch',    'forms/dispatch-form.html'],
  ['form-quality',     'forms/quality-form.html'],
  ['form-stoppage',    'forms/stoppage-form.html'],
  ['form-power',       'forms/power-form.html'],
  ['form-limestone',   'forms/limestone-form.html'],
  ['form-materials',   'forms/materials-form.html'],
  ['form-pile',        'forms/pile-quality-form.html'],
  ['form-salesproj',   'forms/sales-projection-form.html'],
  ['login',            'login.html'],
  ['forgot-password',  'forgot-password.html'],
];

const pick = (list, csv, key) => {
  if (!csv) return list;
  const want = csv.split(',').map(s => s.trim());
  return list.filter(x => want.includes(key(x)));
};
const VIEWPORTS = pick(ALL_VIEWPORTS, arg('viewports'), v => v.name);
const PAGES     = pick(ALL_PAGES,     arg('pages'),     p => p[0]);

/* Motion off. A capture that lands mid-transition reports a defect that
   only ever existed for 200ms. */
const FREEZE = `*,*::before,*::after{transition:none!important;animation:none!important;
  scroll-behavior:auto!important;caret-color:transparent!important}`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const manifest = [];
  let shots = 0;

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dsf,
      isMobile: vp.mobile,
      hasTouch: vp.mobile,
      reducedMotion: 'reduce',
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
    if (/login\.html/.test(page.url())) {
      console.error(`\nCannot sign in as ${USER}. Recreate the harness accounts:\n` +
                    `    node -e "require('./global-setup.js')()"\n`);
      await browser.close();
      process.exit(2);
    }

    for (const [label, url] of PAGES) {
      const dir = path.join(OUT, label);
      fs.mkdirSync(dir, { recursive: true });

      try {
        await page.goto(BASE + '/' + url, { waitUntil: 'networkidle', timeout: 30000 });
      } catch (_) { /* a slow API must not abort the capture */ }
      await page.addStyleTag({ content: FREEZE }).catch(() => {});
      /* Charts animate on first paint and lazy sections hydrate late. */
      await page.waitForTimeout(2200);

      const h = await page.evaluate(() => document.documentElement.scrollHeight)
        .catch(() => vp.height);
      const frames = Math.min(MAXFRAMES, Math.max(1, Math.ceil(h / vp.height)));

      for (let f = 0; f < frames; f++) {
        await page.evaluate(y => window.scrollTo(0, y), f * vp.height);
        await page.waitForTimeout(450);
        const file = path.join(dir, `${vp.name}__f${f}.png`);
        await page.screenshot({ path: file }).catch(() => {});
        manifest.push({ page: label, url, viewport: vp.name, frame: f,
                        w: vp.width, h: vp.height, scrollHeight: h, file });
        shots++;
      }
      process.stdout.write(`  ${vp.name.padEnd(8)} ${label.padEnd(18)} ${frames} frame(s)  h=${h}\n`);
    }
    await ctx.close();
  }

  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${shots} screenshots → ${OUT}`);
  await browser.close();
})();
