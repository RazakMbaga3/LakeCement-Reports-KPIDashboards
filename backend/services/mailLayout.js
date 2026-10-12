/*
  services/mailLayout.js — the one letterhead every MIS email uses.

  Extracted from authMail.js (2026-10-12) so the compliance reminders and the
  account emails cannot drift into looking like they came from different
  systems. Plain inline-styled table HTML on purpose: these go to Outlook and
  to phones on a plant site, where a stylesheet, a web font or a remote image
  would each be stripped or blocked somewhere. Nyati navy (#173158) and
  orange (#F49545) are literals for the same reason.

  APP_URL is where links point. It has no default: a link built against the
  wrong host is worse than no link, because it looks like it should work.
*/
const NAVY   = '#173158';
const ORANGE = '#F49545';

function appUrl() {
  const raw = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return raw || null;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* A button as a bulletproof table cell. `primary` = navy on orange (the
   call to action), otherwise white on navy. */
function buttonHTML(label, href, { primary = false } = {}) {
  const bg = primary ? ORANGE : NAVY;
  const fg = primary ? NAVY : '#ffffff';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0;">
            <tr><td style="background:${bg};border-radius:7px;">
              <a href="${href}" style="display:inline-block;padding:12px 26px;color:${fg};font-size:14px;font-weight:800;letter-spacing:.4px;text-decoration:none;">${label}</a>
            </td></tr>
          </table>`;
}

/* shell({ heading, lead, bodyHtml, buttonLabel, buttonHref, primaryButton,
           linkNote, footnote, system, footer })
   heading/lead/bodyHtml/linkNote/footnote are HTML the caller has already
   escaped. `system` names the sending system under the letterhead. */
function shell(o) {
  const system = o.system || 'Management Information System';
  const button = o.buttonHref
    ? `<div style="margin:0 0 20px;">${buttonHTML(o.buttonLabel, o.buttonHref, { primary: !!o.primaryButton })}</div>` : '';
  const linkNote = o.linkNote
    ? `<p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#64748B;">${o.linkNote}</p>` : '';
  const foot = o.footnote
    ? `<p style="margin:0;font-size:12px;line-height:1.6;color:#64748B;border-top:1px solid #E2E8F0;padding-top:14px;">${o.footnote}</p>` : '';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F4F6F9;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${o.wide ? 640 : 540}px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #E2E8F0;">
        <tr><td style="background:${NAVY};padding:20px 28px;">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.3px;">LAKE CEMENT LTD.</div>
          <div style="color:#A9BBD4;font-size:11px;margin-top:2px;">${system}</div>
        </td></tr>
        <tr><td style="height:3px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 14px;font-size:19px;color:${NAVY};font-weight:700;">${o.heading}</h1>
          ${o.lead ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${o.lead}</p>` : ''}
          ${o.bodyHtml || ''}
          ${button}
          ${linkNote}
          ${foot}
        </td></tr>
        <tr><td style="background:#F8FAFC;padding:14px 28px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;">
          ${o.footer || 'Lake Cement Ltd. &middot; Nyati Cement &middot; This message was sent by the MIS. Please do not reply.'}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

module.exports = { NAVY, ORANGE, appUrl, esc, shell, buttonHTML };
