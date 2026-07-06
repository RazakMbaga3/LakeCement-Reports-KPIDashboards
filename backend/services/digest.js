/*
  services/digest.js — morning KPI digest email.

  Composes yesterday's headline KPIs vs target (from the formula layer)
  plus a missing-submissions warning, and mails it to DIGEST_TO.

  Configuration (.env):
    SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM  — mail server
    DIGEST_TO    — comma-separated recipient list
    DIGEST_CRON  — schedule (default '0 6 * * *' = 06:00 daily)
  If SMTP is not configured the digest silently skips (per the build spec);
  DIGEST_TRANSPORT=json swaps in nodemailer's jsonTransport so the compose
  and send pipeline can be tested without a mail server (acceptance tests).
*/

const { sendMail } = require('./mailer');
const { gatherDaily } = require('./misReport');
const { kpiStatus, fmt, esc } = require('./misRender');

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

/* Email-safe HTML: inline styles only (many clients strip <style>) */
function composeDigest(payload) {
  const td = 'padding:6px 10px;border:1px solid #E8EDF3;font-size:13px;';
  const rows = payload.kpis.map(k => {
    const st = kpiStatus(k);
    const color = st.cls === 'ok' ? '#239557' : st.cls === 'bad' ? '#DC2626' : '#64748B';
    return `<tr>
      <td style="${td}">${esc(k.label)}${k.overridden ? ' <span style="color:#B45309">⚑</span>' : ''}</td>
      <td style="${td}text-align:right">${fmt(k.value, k.dp)} ${esc(k.unit || '')}</td>
      <td style="${td}text-align:right;color:#64748B">${k.target == null ? '—' : esc(k.signage || '') + ' ' + fmt(k.target, k.dp)}</td>
      <td style="${td}color:${color};font-weight:700">${st.text || '—'}</td>
    </tr>`;
  }).join('');

  const missing = payload.missing.length
    ? `<p style="background:#FEF3C7;border:1px solid #FCD34D;color:#92400E;padding:10px 14px;border-radius:6px;font-size:13px">
         ⚠ No submission received yesterday for: <strong>${payload.missing.map(esc).join(', ')}</strong></p>`
    : '';

  const html = `
  <div style="font-family:Segoe UI,system-ui,sans-serif;max-width:680px;margin:0 auto;color:#173158">
    <div style="background:#173158;border-bottom:4px solid #F49545;padding:16px 20px;border-radius:8px 8px 0 0">
      <div style="color:white;font-size:17px;font-weight:800">NYATI CEMENT — DAILY MIS DIGEST</div>
      <div style="color:#94A3B8;font-size:12px;margin-top:2px">Plant performance for ${esc(payload.date)}</div>
    </div>
    <div style="border:1px solid #DDE3EC;border-top:none;padding:18px 20px;border-radius:0 0 8px 8px">
      ${missing}
      <table style="width:100%;border-collapse:collapse;margin-top:6px">
        <tr>
          <th style="${td}background:#EEF2F7;text-align:left;font-size:11px;color:#64748B">KPI</th>
          <th style="${td}background:#EEF2F7;text-align:right;font-size:11px;color:#64748B">Value</th>
          <th style="${td}background:#EEF2F7;text-align:right;font-size:11px;color:#64748B">Target</th>
          <th style="${td}background:#EEF2F7;text-align:left;font-size:11px;color:#64748B">Status</th>
        </tr>
        ${rows}
      </table>
      <p style="color:#94A3B8;font-size:11px;margin-top:14px">
        ⚑ = manually overridden value (audited). Full detail: open the MIS dashboard →
        Reports → Daily Report for ${esc(payload.date)}.
      </p>
    </div>
  </div>`;

  return { subject: `Nyati MIS Daily Digest — ${payload.date}`, html };
}

/* Send the digest for `date` (default: yesterday, local time). */
async function sendDigest(date) {
  const payload = await gatherDaily(date || yesterday());
  const { subject, html } = composeDigest(payload);
  const result = await sendMail({ subject, html, to: process.env.DIGEST_TO });
  return { ...result, date: payload.date };
}

module.exports = { sendDigest, composeDigest, yesterday };
