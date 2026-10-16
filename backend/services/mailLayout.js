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
   call to action), otherwise white on navy.

   bgcolor= repeats the background as an HTML attribute, not only as CSS:
   Outlook 2016+ honours the attribute when a dark-mode theme has rewritten
   the inline `background`, and a client that drops the colour entirely
   would otherwise leave white-on-white or navy-on-navy text. The tap target
   is 48px tall (14px text + 2x16px padding + line-height) — the minimum a
   thumb can hit reliably on a phone, which is how most of the plant will
   read this. */
function buttonHTML(label, href, { primary = false } = {}) {
  const bg = primary ? ORANGE : NAVY;
  const fg = primary ? NAVY : '#ffffff';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
            <tr><td bgcolor="${bg}" style="background:${bg};border-radius:7px;mso-padding-alt:16px 28px;">
              <a href="${href}" style="display:inline-block;padding:16px 28px;color:${fg};font-size:15px;font-weight:800;letter-spacing:.4px;text-decoration:none;">${label}</a>
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
  /* `preheader` is the grey line the inbox shows after the subject. Left
     unset, Gmail and Outlook web scrape "LAKE CEMENT LTD. Management
     Information System" off the letterhead and show that instead — the two
     things the reader already knows from the sender. Hidden in the body,
     padded so no visible body copy is pulled in after it. */
  const pre = o.preheader
    ? `<div style="display:none;font-size:1px;color:#F4F6F9;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${o.preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- Tell iOS Mail / Apple Mail / Outlook.com this design has its own light
     and dark treatment, so they stop auto-inverting partway and leaving
     half-legible mixes. Every colour below is also repeated as a bgcolor
     attribute for the clients that ignore this. -->
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${o.heading}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6F9;font-family:Segoe UI,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%;">
  ${pre}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F4F6F9" style="background:#F4F6F9;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:${o.wide ? 640 : 540}px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #E2E8F0;">
        <tr><td bgcolor="${NAVY}" style="background:${NAVY};padding:20px 28px;">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.3px;">LAKE CEMENT LTD.</div>
          <div style="color:#A9BBD4;font-size:11px;margin-top:2px;">${system}</div>
        </td></tr>
        <tr><td bgcolor="${ORANGE}" style="height:3px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 14px;font-size:19px;color:${NAVY};font-weight:700;">${o.heading}</h1>
          ${o.lead ? `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${o.lead}</p>` : ''}
          ${o.bodyHtml || ''}
          ${button}
          ${linkNote}
          ${foot}
        </td></tr>
        <tr><td bgcolor="#F8FAFC" style="background:#F8FAFC;padding:14px 28px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;">
          ${o.footer || 'Lake Cement Ltd. &middot; Nyati Cement &middot; This message was sent by the MIS. Please do not reply.'}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/* textShell({ heading, lines, url, urlLabel, footnote, footer })
   The plain-text alternative. Every HTML email needs one: it is what a
   screen reader in text mode, a locked-down Outlook, a smartwatch and most
   spam filters actually read, and a message with no text part scores worse
   at the gateway. `lines` are plain strings (no escaping, no markup) —
   build them from the SAME source copy as the HTML so the two cannot drift. */

/* Wrap at 72 columns — narrow enough that Outlook's plain-text reader and a
   phone in portrait do not re-wrap it into a ragged mess. A leading-space
   indent (the numbered steps) is preserved on continuation lines, and a
   token longer than the limit is never broken: that token is the link, and
   a wrapped URL is a dead URL. The URL itself is pushed below unwrapped. */
function wrap72(line, width = 72) {
  if (line.length <= width) return [line];
  const indent = (line.match(/^\s*/) || [''])[0];
  const out = [];
  let cur = '';
  for (const word of line.trim().split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (indent.length + next.length > width && cur) { out.push(indent + cur); cur = word; }
    else cur = next;
  }
  if (cur) out.push(indent + cur);
  return out;
}

function textShell({ heading, lines = [], url, urlLabel, footnote, footer }) {
  const rule = '-'.repeat(60);
  const body = [];
  for (const l of lines) body.push(...wrap72(String(l)));
  const out = [
    'LAKE CEMENT LTD. — Management Information System',
    rule, '',
    heading.toUpperCase(), '',
    ...body,
  ];
  if (url) out.push('', `${urlLabel || 'Open this link'}:`, url);
  if (footnote) {
    out.push('');
    for (const l of String(footnote).split('\n')) out.push(...(l ? wrap72(l) : ['']));
  }
  out.push('', rule,
    footer || 'Lake Cement Ltd. · Nyati Cement · Sent by the MIS. Please do not reply.');
  return out.join('\n');
}

module.exports = { NAVY, ORANGE, appUrl, esc, shell, buttonHTML, textShell };
