/* Throwaway probe: contrast of every button/pill against its own fill.
   node probe.js <page-path> [width] */
'use strict';
const { chromium } = require('@playwright/test');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:3000';
const URL  = process.argv[2] || 'reports-export.html';
const W    = parseInt(process.argv[3] || '390', 10);

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: W, height: 900 }, isMobile: W < 900, hasTouch: W < 900 });
  const p = await c.newPage();
  await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  await p.fill('#username', 'e2e_admin'); await p.fill('#password', 'E2E@Harness2026!');
  await Promise.all([p.waitForNavigation().catch(()=>{}), p.click('button[type=submit]')]);
  await p.waitForTimeout(1000);
  await p.goto(BASE + '/' + URL, { waitUntil: 'networkidle' }).catch(()=>{});
  await p.waitForTimeout(2500);

  const out = await p.evaluate(() => {
    const parse = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null;
      const q = m[1].split(',').map(s => parseFloat(s.trim()));
      return { r:q[0], g:q[1], b:q[2], a:q.length>3?q[3]:1 }; };
    const lum = ({r,g,b}) => { const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);};
      return .2126*f(r)+.7152*f(g)+.0722*f(b); };
    const over = (fg,bg)=>({ r:fg.r*fg.a+bg.r*(1-fg.a), g:fg.g*fg.a+bg.g*(1-fg.a), b:fg.b*fg.a+bg.b*(1-fg.a), a:1 });
    const ratio=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+.05)/(y+.05);};
    const bgOf = el => { let n=el; while(n&&n!==document.documentElement){ const c=parse(getComputedStyle(n).backgroundColor);
      if(c&&c.a>0){ if(c.a===1) return c; return over(c,bgOf(n.parentElement||document.body)); } n=n.parentElement; }
      return {r:255,g:255,b:255,a:1}; };

    const res = [];
    document.querySelectorAll('button, a.btn, .btn, [class*=btn], [class*=chip], [class*=pill], [class*=badge]').forEach(el => {
      const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return;
      /* The off-canvas drawer is translated out of view, not hidden, so its
         contents still measure — and against the wrong background. */
      if (r.right <= 0 || r.left >= window.innerWidth) return;
      if (el.closest('.ms-drawer, .sidebar, #app-sidebar')) return;
      const s = getComputedStyle(el);
      const txt = (el.textContent||'').trim(); if (!txt) return;
      const bg = bgOf(el); const fg = parse(s.color); if (!fg) return;
      const cr = ratio(over(fg,bg), bg);
      const big = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
      if (cr < (big ? 3 : 4.5)) {
        res.push({ sig: el.tagName.toLowerCase()+'.'+String(el.className).trim().split(/\s+/)[0],
                   text: txt.slice(0,26), ratio:+cr.toFixed(2), color:s.color,
                   bg:`rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`,
                   fs: s.fontSize, fw: s.fontWeight });
      }
    });
    return res;
  });
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})();
