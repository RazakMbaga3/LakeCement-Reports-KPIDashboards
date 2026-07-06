/*
  services/misRender.js — renders a misReport payload as a self-contained,
  printable HTML document (Nyati brand, @media print CSS). PDF is produced
  by the browser's own print-to-PDF on this view — no headless-browser
  dependency on the plant server.
*/

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(v, dp) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return esc(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: dp ?? 2 });
}

function kpiStatus(k) {
  if (k.value == null || k.target == null || !k.signage) return { text: '', cls: '' };
  const v = k.value, t = k.target;
  const ok = k.signage === '<' ? v < t : k.signage === '<=' ? v <= t :
             k.signage === '>' ? v > t : k.signage === '>=' ? v >= t : v === t;
  return ok ? { text: 'Achieved', cls: 'ok' } : { text: 'Not Achieved', cls: 'bad' };
}

const CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',system-ui,sans-serif; color:#173158; background:white; padding:28px; font-size:12px; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:4px solid #F49545; padding-bottom:12px; margin-bottom:18px; }
  .head h1 { font-size:19px; letter-spacing:.5px; }
  .head .sub { color:#64748B; font-size:12px; margin-top:3px; }
  .head .brand { text-align:right; font-weight:800; font-size:14px; color:#173158; }
  .head .brand small { display:block; font-weight:400; color:#94A3B8; font-size:10px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.8px; color:white; background:#173158;
       padding:6px 12px; border-radius:4px; margin:20px 0 8px; page-break-after:avoid; }
  table { width:100%; border-collapse:collapse; font-size:11px; page-break-inside:auto; }
  th { background:#EEF2F7; text-align:left; padding:5px 8px; border:1px solid #DDE3EC; font-size:10px;
       text-transform:uppercase; letter-spacing:.4px; color:#64748B; }
  td { padding:5px 8px; border:1px solid #E8EDF3; }
  tr { page-break-inside:avoid; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .ok  { color:#239557; font-weight:700; }
  .bad { color:#DC2626; font-weight:700; }
  .ov  { color:#B45309; font-weight:700; }
  .meta { color:#94A3B8; font-size:10px; margin-top:4px; }
  .missing { background:#FEF3C7; border:1px solid #FCD34D; color:#92400E; border-radius:6px; padding:8px 12px; margin:10px 0; font-size:11px; }
  .foot { margin-top:26px; border-top:1px solid #E8EDF3; padding-top:8px; color:#94A3B8; font-size:10px; display:flex; justify-content:space-between; }
  @media print {
    body { padding:0; }
    .no-print { display:none; }
  }
  .no-print { position:fixed; top:14px; right:14px; }
  .no-print button { background:#F49545; color:white; border:none; border-radius:7px; padding:9px 18px;
       font-weight:700; font-size:12px; cursor:pointer; box-shadow:0 3px 12px rgba(0,0,0,.2); }
`;

function page(title, subtitle, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
<div class="head">
  <div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div>
  <div class="brand">LAKE CEMENT LTD<small>Nyati Cement — Management Information System</small></div>
</div>
${body}
<div class="foot"><span>Lake Cement Ltd — internal use only</span><span>Generated ${new Date().toLocaleString('en-GB')}</span></div>
</body></html>`;
}

/* benchmarks (optional): map key → {prevMonth, lastYear, bestEver} — the
   monthly report passes it so KPIs read against their own history. */
function kpiTable(kpis, valueHeader, benchmarks) {
  const benchCell = b => b && b.value != null
    ? `<td class="num">${fmt(b.value)}<span class="meta"> ${esc(b.period || '')}</span></td>`
    : '<td class="num">—</td>';

  const rows = kpis.map(k => {
    const st = kpiStatus(k);
    const b  = benchmarks ? benchmarks[k.key] : null;
    return `<tr>
      <td>${esc(k.label)}</td>
      <td>${esc(k.unit || '')}</td>
      <td class="num">${k.target == null ? '—' : esc(k.signage || '') + ' ' + fmt(k.target, k.dp)}</td>
      <td class="num">${fmt(k.value, k.dp)}${k.overridden ? ' <span class="ov" title="Manual override">⚑</span>' : ''}</td>
      ${benchmarks ? benchCell(b && b.prevMonth) + benchCell(b && b.lastYear) + benchCell(b && b.bestEver) : ''}
      <td class="${st.cls}">${st.text}</td>
      ${k.overridden && k.override ? `<td>${esc(k.override.by || '')}: ${esc(k.override.reason || '')}</td>` : '<td></td>'}
    </tr>`;
  }).join('');

  const benchHead = benchmarks ? '<th>Prev month</th><th>Same month LY</th><th>Best ever</th>' : '';
  return `<table><tr><th>KPI</th><th>Unit</th><th>Target</th><th>${esc(valueHeader)}</th>${benchHead}<th>Status</th><th>Override note</th></tr>${rows}</table>`;
}

/* ── Daily ─────────────────────────────────────────────────── */
function renderDailyHtml(p) {
  let body = '<h2>Key Performance Indicators</h2>' + kpiTable(p.kpis, 'Value');

  if (p.missing.length) {
    body += `<div class="missing">⚠ No submission received for: <strong>${p.missing.map(esc).join(', ')}</strong></div>`;
  }

  for (const f of p.forms) {
    body += `<h2>${esc(f.label)}${f.shift && f.shift !== 'day' ? ' — ' + esc(f.shift) + ' shift' : ''}</h2>`;
    body += `<div class="meta">Submitted by ${esc(f.submittedBy || '—')} · status: ${esc(f.status)}</div>`;
    const rows = f.fields.map(fl =>
      `<tr><td>${esc(fl.label)}</td><td class="num">${fmt(fl.value)}</td></tr>`).join('');
    body += `<table><tr><th style="width:60%">Field</th><th>Value</th></tr>${rows}</table>`;
  }

  return page(`Daily MIS Report — ${p.date}`, 'All department submissions and computed KPIs for the day', body);
}

/* ── Monthly ───────────────────────────────────────────────── */
function renderMonthlyHtml(p) {
  let body = '<h2>Monthly KPI Summary</h2>' + kpiTable(p.kpis, 'Actual (month)', p.benchmarks);

  for (const f of p.forms) {
    body += `<h2>${esc(f.label)} — day by day</h2>`;
    const head = '<tr><th>Date</th>' + f.fields.map(fl => `<th>${esc(fl.label)}</th>`).join('') + '</tr>';
    const rows = f.days.map(d =>
      `<tr><td>${esc(d.date)}${d.shift !== 'day' ? ' (' + esc(d.shift) + ')' : ''}</td>` +
      d.values.map(v => `<td class="num">${fmt(v)}</td>`).join('') + '</tr>').join('');
    body += `<div style="overflow-x:auto"><table>${head}${rows}</table></div>`;
  }

  return page(`Monthly MIS Report — ${p.monthName} ${p.year}`,
    `${p.from} to ${p.to} — formula-layer KPIs (overrides flagged ⚑) and daily submissions`, body);
}

module.exports = { renderDailyHtml, renderMonthlyHtml, kpiStatus, fmt, esc };
