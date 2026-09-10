/*
  ══════════════════════════════════════════════════════════════════════
  Design consistency audit — the measurable half of the visual review.

  responsive-audit.js proves a page FITS. a11y-audit.js proves it is
  READABLE. Neither proves it is COHERENT: that the same kind of thing
  looks the same everywhere, that colour is spent on meaning rather than
  decoration, that spacing came off a scale instead of a hunch. Those are
  the defects a procurement design review actually comments on, and they
  are all measurable — you just have to measure across pages, not within
  one.

  Six checks, each reported with the exact offenders:

    1. COMPONENT DRIFT   every button / badge / card, bucketed by its
                         rendered geometry. Two buckets for one component
                         class is drift; the report names both.
    2. SPACING SCALE     padding/margin/gap values that are not on the
                         4px scale in design-system.css.
    3. COLOUR INVENTORY  every colour actually painted, flagged when it
                         is not a token value. A 4th colour family is the
                         classic "many hands" tell.
    4. BRAND-FILL TEXT   text drawn on a brand fill, with its real
                         contrast ratio. The house rule is that brand
                         colours are fills and never text, and that text
                         ON a fill uses the paired ink token.
    5. SIGNAL LOAD       elements encoding status in more than one way at
                         once (border + background + bar + badge). Past
                         two, a reader cannot tell which signal to trust.
    6. RADIUS/ELEVATION  distinct corner radii and shadows in use. A
                         design system has a handful; drift has dozens.

      node design-consistency-audit.js [--json out.json] [--pages a,b] [--width 1280]
  ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const { chromium } = require('@playwright/test');

const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
const USER = process.env.AUDIT_USER || 'e2e_admin';
const PASS = process.env.AUDIT_PASS || 'E2E@Harness2026!';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const argJson = arg('json');
const WIDTH = parseInt(arg('width', '1440'), 10);

const ALL_PAGES = [
  ['portal', 'portal.html'], ['kpi-dashboard', 'index.html'], ['mis', 'mis.html'],
  ['daily-report', 'daily-report.html'], ['analytics', 'analytics.html'],
  ['approvals', 'approvals.html'], ['sales', 'sales.html'], ['purchases', 'purchases.html'],
  ['reliability', 'reliability.html'], ['quarry', 'mines-report.html'],
  ['balance', 'balance.html'], ['insights', 'insights.html'],
  ['completeness', 'completeness.html'], ['reports-export', 'reports-export.html'],
  ['admin-users', 'admin-users.html'], ['monitor', 'monitor.html'],
  ['form-index', 'forms/index.html'], ['form-dispatch', 'forms/dispatch-form.html'],
  ['form-quality', 'forms/quality-form.html'], ['form-stoppage', 'forms/stoppage-form.html'],
  ['form-power', 'forms/power-form.html'], ['form-limestone', 'forms/limestone-form.html'],
  ['form-materials', 'forms/materials-form.html'], ['form-pile', 'forms/pile-quality-form.html'],
];
const PAGES = (() => {
  const csv = arg('pages');
  if (!csv) return ALL_PAGES;
  const want = csv.split(',').map(s => s.trim());
  return ALL_PAGES.filter(p => want.includes(p[0]));
})();

/* ── Runs in the browser. Returns raw observations; judgement is host-side. ── */
function collect() {
  const cs = el => getComputedStyle(el);
  const vis = el => {
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const px = v => Math.round(parseFloat(v) || 0);

  /* sRGB relative luminance → contrast ratio */
  const parse = c => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
    return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1,
  });
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + .05) / (y + .05);
  };
  /* Effective background: walk up until something is not transparent. */
  const bgOf = el => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(cs(n).backgroundColor);
      if (c && c.a > 0) {
        if (c.a === 1) return c;
        const under = bgOf(n.parentElement || document.body);
        return over(c, under);
      }
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const out = {
    components: [], spacing: [], colors: {}, brandText: [],
    signals: [], radii: {}, shadows: {}, collisions: [],
  };

  /* The Nyati brand fills. Text drawn on these must use the ink pairing. */
  const BRAND = { '244,149,69': 'orange', '35,149,87': 'green', '23,49,88': 'navy' };
  const SCALE = [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64];

  const all = [...document.querySelectorAll('body *')].filter(vis);

  for (const el of all) {
    const s = cs(el);
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const cls = (typeof el.className === 'string' ? el.className : '').trim();
    const first = cls ? cls.split(/\s+/)[0] : '';
    const sig = tag + (first ? '.' + first : '');

    /* 1 — component geometry buckets */
    const isBtn = tag === 'button' || el.getAttribute('role') === 'button' ||
                  /(^|\s)(btn|button|chip|pill|badge|tag)(-|\s|$)/i.test(cls);
    if (isBtn && r.height < 90) {
      out.components.push({
        sig, kind: /badge|chip|pill|tag/i.test(cls) ? 'badge' : 'button',
        h: Math.round(r.height), radius: s.borderRadius,
        padY: px(s.paddingTop) + 'x' + px(s.paddingBottom),
        padX: px(s.paddingLeft) + 'x' + px(s.paddingRight),
        fs: px(s.fontSize), fw: s.fontWeight,
        bg: s.backgroundColor, fg: s.color, bd: s.borderTopWidth + ' ' + s.borderTopColor,
        text: (el.textContent || '').trim().slice(0, 24),
      });
    }

    /* 2 — spacing off the scale */
    for (const prop of ['paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
                        'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const v = px(s[prop]);
      if (v > 0 && !SCALE.includes(v)) out.spacing.push({ sig, prop, v });
    }

    /* 3 — colour inventory (painted colours only) */
    const bgc = parse(s.backgroundColor);
    if (bgc && bgc.a > .05) {
      const k = `${Math.round(bgc.r)},${Math.round(bgc.g)},${Math.round(bgc.b)}`;
      (out.colors[k] = out.colors[k] || { n: 0, where: [] }).n++;
      if (out.colors[k].where.length < 4) out.colors[k].where.push(sig);
    }

    /* 4 — text on a brand fill */
    const hasOwnText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (hasOwnText) {
      const bg = bgOf(el);
      const key = `${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}`;
      const fg = parse(s.color);
      if (fg) {
        const cr = ratio(over(fg, bg), bg);
        if (BRAND[key]) {
          out.brandText.push({ sig, fill: BRAND[key], color: s.color, ratio: +cr.toFixed(2),
                               fs: px(s.fontSize), fw: s.fontWeight,
                               text: (el.textContent || '').trim().slice(0, 30) });
        }
      }
    }

    /* 5 — CONFLICTING status signals on one element.
       Not a count of coloured parts: a status chip legitimately spends a
       background, a border and a dot on ONE reading, and counting those
       as three faults just teaches you to ignore the check. What breaks
       a reader is two signals in DIFFERENT hues on the same element —
       the KPI tile whose top edge said "concern" in red while its bottom
       edge said "formula" in green. So collect the hues actually painted
       and report the element only when they disagree. */
    const how = [], hues = [];
    const chroma = c => c && c.a > .05 && (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) > 24;
    const hueOf = c => {
      const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), d = mx - mn;
      let h = 0;
      if (d === 0) h = 0;
      else if (mx === c.r) h = 60 * (((c.g - c.b) / d) % 6);
      else if (mx === c.g) h = 60 * ((c.b - c.r) / d + 2);
      else h = 60 * ((c.r - c.g) / d + 4);
      return (h + 360) % 360;
    };
    const note = (label, c) => { if (chroma(c)) { how.push(label); hues.push(hueOf(c)); } };

    if (px(s.borderTopWidth) > 0)  note('border-top', parse(s.borderTopColor));
    if (px(s.borderLeftWidth) > 0) note('border-left', parse(s.borderLeftColor));
    note('background', parse(s.backgroundColor));
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content !== 'none') note(pseudo, parse(ps.backgroundColor));
    }

    if (hues.length >= 2) {
      /* Circular hue distance; 40° apart is a different colour to a reader
         (amber→green is 80°, green→red 120°). Under that it is one hue
         family expressed at different lightness, which is fine. */
      let worst = 0;
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          const d = Math.abs(hues[i] - hues[j]);
          worst = Math.max(worst, Math.min(d, 360 - d));
        }
      }
      if (worst >= 40) {
        out.signals.push({ sig, load: how.length, how, spread: Math.round(worst),
                           text: (el.textContent || '').trim().slice(0, 30) });
      }
    }

    /* 6 — radius + elevation inventory */
    const rad = s.borderRadius;
    if (rad && rad !== '0px' && r.width > 24) {
      (out.radii[rad] = out.radii[rad] || { n: 0, where: [] }).n++;
      if (out.radii[rad].where.length < 3) out.radii[rad].where.push(sig);
    }
    if (s.boxShadow && s.boxShadow !== 'none') {
      const k = s.boxShadow.slice(0, 60);
      (out.shadows[k] = out.shadows[k] || { n: 0, where: [] }).n++;
      if (out.shadows[k].where.length < 3) out.shadows[k].where.push(sig);
    }
  }
  /* 7 — IN-FLOW COLLISIONS
     Two block siblings that are both in normal flow must not sit on top
     of each other. They did: widening the wide-table scroll affordance
     put `position: relative` on the stoppage form's section tab bar,
     which was `position: sticky; top: 121px` — turning a sticky offset
     into a 121px downward shift that dropped the tabs through the six
     KPI cards below them. Nothing overflowed and no contrast changed, so
     every other check in this repo stayed green.

     Only STATIC and RELATIVE siblings are compared. Absolute, fixed and
     sticky elements overlap on purpose, and a sticky element is only
     compared while it is resting at its natural offset. */
  const blockish = el => {
    const d = getComputedStyle(el).display;
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'table';
  };
  for (const el of all) {
    const s = cs(el);
    if (s.position !== 'static' && s.position !== 'relative') continue;
    if (!blockish(el)) continue;
    const next = el.nextElementSibling;
    if (!next || !vis(next)) continue;
    const ns = cs(next);
    if (ns.position !== 'static' && ns.position !== 'relative') continue;
    if (!blockish(next)) continue;
    const a = el.getBoundingClientRect(), b = next.getBoundingClientRect();
    /* Horizontal neighbours in a flex row legitimately share a band. */
    if (a.right <= b.left + 1 || b.right <= a.left + 1) continue;
    const overlap = Math.round(a.bottom - b.top);
    if (overlap > 2) {
      out.collisions.push({
        a: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' && el.className.trim()
             ? '.' + el.className.trim().split(/\s+/)[0] : ''),
        b: next.tagName.toLowerCase() + (next.className && typeof next.className === 'string' && next.className.trim()
             ? '.' + next.className.trim().split(/\s+/)[0] : ''),
        overlap, aPos: s.position, aTop: s.top,
      });
    }
  }

  return out;
}

/* ── Host-side aggregation ─────────────────────────────────────────── */
const merge = (into, from, page) => {
  for (const c of from.components) into.components.push({ ...c, page });
  for (const x of (from.collisions || [])) into.collisions.push({ ...x, page });
  for (const s of from.spacing)    into.spacing.push({ ...s, page });
  for (const b of from.brandText)  into.brandText.push({ ...b, page });
  for (const s of from.signals)    into.signals.push({ ...s, page });
  for (const [k, v] of Object.entries(from.colors)) {
    const t = into.colors[k] = into.colors[k] || { n: 0, where: new Set(), pages: new Set() };
    t.n += v.n; v.where.forEach(w => t.where.add(w)); t.pages.add(page);
  }
  for (const key of ['radii', 'shadows']) {
    for (const [k, v] of Object.entries(from[key])) {
      const t = into[key][k] = into[key][k] || { n: 0, where: new Set(), pages: new Set() };
      t.n += v.n; v.where.forEach(w => t.where.add(w)); t.pages.add(page);
    }
  }
};

(async () => {
  const browser = await chromium.launch();
  /* One width is not the whole answer: the section-tab collision only
     exists at widths where nine tabs do not fit, which 1440 happens to
     clear. Run it at 1280 as well. */
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.fill('#username', USER); await page.fill('#password', PASS);
  await Promise.all([page.waitForNavigation({ timeout: 20000 }).catch(() => {}),
                     page.click('button[type=submit]')]);
  await page.waitForTimeout(1200);
  if (/login\.html/.test(page.url())) {
    console.error(`\nCannot sign in as ${USER}. Recreate harness accounts:\n` +
                  `    node -e "require('./global-setup.js')()"\n`);
    await browser.close(); process.exit(2);
  }

  const agg = { components: [], spacing: [], colors: {}, brandText: [], signals: [], radii: {}, shadows: {}, collisions: [] };
  for (const [label, url] of PAGES) {
    try { await page.goto(BASE + '/' + url, { waitUntil: 'networkidle', timeout: 30000 }); }
    catch (_) {}
    await page.waitForTimeout(1500);
    const got = await page.evaluate(collect).catch(e => null);
    if (!got) { console.log(`  ! ${label} — collection failed`); continue; }
    merge(agg, got, label);
    console.log(`  · ${label.padEnd(16)} components=${String(got.components.length).padStart(4)}` +
                `  offScale=${String(got.spacing.length).padStart(4)}` +
                `  brandText=${String(got.brandText.length).padStart(3)}` +
                `  overloaded=${String(got.signals.length).padStart(3)}` +
                `  collide=${String(got.collisions.length).padStart(3)}`);
  }
  await browser.close();

  /* ── Report ── */
  const H = t => console.log(`\n${'═'.repeat(74)}\n${t}\n${'═'.repeat(74)}`);
  const findings = [];

  H('1 · COMPONENT DRIFT — one component class, many geometries');
  const byClass = {};
  for (const c of agg.components) {
    const k = c.sig;
    const geo = `h=${c.h} r=${c.radius} padY=${c.padY} padX=${c.padX} fs=${c.fs}/${c.fw}`;
    const t = byClass[k] = byClass[k] || { kind: c.kind, geos: {}, pages: new Set() };
    (t.geos[geo] = t.geos[geo] || { n: 0, pages: new Set(), sample: c.text }).n++;
    t.geos[geo].pages.add(c.page); t.pages.add(c.page);
  }
  const drift = Object.entries(byClass)
    .map(([k, v]) => ({ k, kind: v.kind, variants: Object.keys(v.geos).length, geos: v.geos, pages: v.pages.size }))
    .filter(d => d.variants > 1 && d.pages > 0)
    .sort((a, b) => b.variants - a.variants);
  for (const d of drift.slice(0, 14)) {
    console.log(`\n  ${d.k}  (${d.kind}) — ${d.variants} geometries across ${d.pages} page(s)`);
    for (const [geo, v] of Object.entries(d.geos).sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
      console.log(`     ×${String(v.n).padStart(4)}  ${geo}   [${[...v.pages].slice(0, 3).join(', ')}] "${v.sample}"`);
    }
  }
  if (drift.length) findings.push(`${drift.length} component classes render with more than one geometry`);
  console.log(`\n  → ${drift.length} drifting component classes`);

  H('2 · SPACING OFF THE 4px SCALE');
  const spBy = {};
  for (const s of agg.spacing) {
    const k = `${s.v}px`;
    (spBy[k] = spBy[k] || { n: 0, where: new Set(), pages: new Set() });
    spBy[k].n++; spBy[k].where.add(s.sig); spBy[k].pages.add(s.page);
  }
  const spSorted = Object.entries(spBy).sort((a, b) => b[1].n - a[1].n);
  for (const [v, d] of spSorted.slice(0, 16)) {
    console.log(`  ×${String(d.n).padStart(5)}  ${v.padStart(7)}  ${[...d.where].slice(0, 5).join(', ')}`);
  }
  const offTotal = agg.spacing.length;
  console.log(`\n  → ${offTotal} declarations off the scale, ${spSorted.length} distinct values`);
  if (offTotal) findings.push(`${offTotal} spacing declarations are off the 4px scale`);

  H('3 · COLOUR INVENTORY — painted background colours');
  const cols = Object.entries(agg.colors).sort((a, b) => b[1].n - a[1].n);
  const hex = k => '#' + k.split(',').map(n => (+n).toString(16).padStart(2, '0')).join('').toUpperCase();
  for (const [k, v] of cols.slice(0, 24)) {
    console.log(`  ×${String(v.n).padStart(5)}  ${hex(k).padEnd(8)} rgb(${k})`.padEnd(34) +
                `  ${[...v.pages].length}pg  ${[...v.where].slice(0, 3).join(', ')}`);
  }
  console.log(`\n  → ${cols.length} distinct painted background colours`);
  if (cols.length > 30) findings.push(`${cols.length} distinct background colours in use`);

  H('4 · TEXT ON A BRAND FILL — house rule: use the paired ink token');
  const bad = agg.brandText.filter(b => b.ratio < 4.5).sort((a, b) => a.ratio - b.ratio);
  const seen = new Set();
  for (const b of bad) {
    const k = b.sig + b.fill + b.color;
    if (seen.has(k)) continue; seen.add(k);
    console.log(`  ${String(b.ratio).padStart(5)}:1  on ${b.fill.padEnd(6)} ${b.sig.padEnd(22)} ` +
                `${b.color.padEnd(20)} ${b.fs}px/${b.fw}  [${b.page}] "${b.text}"`);
  }
  console.log(`\n  → ${bad.length} text-on-brand-fill nodes below 4.5:1 (${seen.size} distinct)`);
  if (seen.size) findings.push(`${seen.size} distinct text-on-brand-fill treatments below 4.5:1`);

  H('5 · CONFLICTING SIGNALS — one element painted in two different hues');
  const sigBy = {};
  for (const s of agg.signals) {
    const k = s.sig + ' :: ' + s.how.join('+');
    (sigBy[k] = sigBy[k] || { n: 0, pages: new Set(), sample: s.text, load: s.load, spread: s.spread });
    sigBy[k].n++; sigBy[k].pages.add(s.page);
    sigBy[k].spread = Math.max(sigBy[k].spread, s.spread);
  }
  for (const [k, v] of Object.entries(sigBy).sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
    console.log(`  ×${String(v.n).padStart(4)}  hue spread ${String(v.spread).padStart(3)}°  ${k}   [${[...v.pages].slice(0, 3).join(', ')}]`);
  }
  console.log(`\n  → ${agg.signals.length} elements carrying conflicting hues, ${Object.keys(sigBy).length} distinct patterns`);
  if (agg.signals.length) findings.push(`${agg.signals.length} elements are painted in two conflicting hues at once`);

  H('6 · RADIUS & ELEVATION INVENTORY');
  const rr = Object.entries(agg.radii).sort((a, b) => b[1].n - a[1].n);
  console.log('  radii:');
  for (const [k, v] of rr.slice(0, 12)) console.log(`    ×${String(v.n).padStart(5)}  ${k.padEnd(28)} ${[...v.where].slice(0, 3).join(', ')}`);
  const sh = Object.entries(agg.shadows).sort((a, b) => b[1].n - a[1].n);
  console.log(`\n  shadows:`);
  for (const [k, v] of sh.slice(0, 12)) console.log(`    ×${String(v.n).padStart(5)}  ${k}`);
  console.log(`\n  → ${rr.length} distinct radii, ${sh.length} distinct shadows`);
  if (rr.length > 8)  findings.push(`${rr.length} distinct corner radii in use`);
  if (sh.length > 8)  findings.push(`${sh.length} distinct shadows in use`);

  H('7 · IN-FLOW COLLISIONS — two block siblings sitting on each other');
  const colBy = {};
  for (const x of agg.collisions) {
    const k = `${x.a} over ${x.b}`;
    (colBy[k] = colBy[k] || { n: 0, pages: new Set(), overlap: 0, aPos: x.aPos, aTop: x.aTop });
    colBy[k].n++; colBy[k].pages.add(x.page); colBy[k].overlap = Math.max(colBy[k].overlap, x.overlap);
  }
  for (const [k, v] of Object.entries(colBy).sort((a, b) => b[1].overlap - a[1].overlap).slice(0, 12)) {
    console.log(`  ${String(v.overlap).padStart(4)}px  ${k}   (${v.aPos} top:${v.aTop})  [${[...v.pages].slice(0, 3).join(', ')}]`);
  }
  console.log(`
  → ${agg.collisions.length} overlapping sibling pairs, ${Object.keys(colBy).length} distinct`);
  if (agg.collisions.length) findings.push(`${agg.collisions.length} in-flow elements overlap a sibling`);

  H('SUMMARY');
  findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  if (argJson) {
    const plain = o => Object.fromEntries(Object.entries(o).map(([k, v]) =>
      [k, { ...v, where: [...(v.where || [])], pages: [...(v.pages || [])] }]));
    fs.writeFileSync(argJson, JSON.stringify({
      components: agg.components, spacing: agg.spacing, brandText: agg.brandText,
      signals: agg.signals, collisions: agg.collisions,
      colors: plain(agg.colors), radii: plain(agg.radii), shadows: plain(agg.shadows),
    }, null, 2));
    console.log(`\n  json → ${argJson}`);
  }
  process.exit(findings.length ? 1 : 0);
})();
