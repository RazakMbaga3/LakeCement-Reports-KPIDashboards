/*
  services/authMail.js — the three account emails: invitation, password
  reset, and address verification.

  Plain inline-styled HTML on purpose. These go to Outlook and to phones on
  a plant site; a stylesheet, a web font or a remote image would each be
  stripped or blocked somewhere. Nyati navy (#173158) and orange (#F49545)
  are inlined as literals for the same reason.

  APP_URL is where the links point. It has no sensible default: a link built
  against the wrong host is worse than no link, because it looks like it
  should work. When it is unset these functions refuse to send and say so,
  rather than mailing out a localhost URL.
*/
const { sendMail } = require('./mailer');

const NAVY   = '#173158';
const ORANGE = '#F49545';

function appUrl() {
  const raw = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return raw || null;
}

/* One shell for all three, so a change to the letterhead cannot leave the
   emails looking like they came from different systems. */
function shell({ heading, lead, buttonLabel, buttonHref, footnote, expiry }) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F4F6F9;font-family:Segoe UI,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #E2E8F0;">
        <tr><td style="background:${NAVY};padding:20px 28px;">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.3px;">LAKE CEMENT LTD.</div>
          <div style="color:#A9BBD4;font-size:11px;margin-top:2px;">Management Information System</div>
        </td></tr>
        <tr><td style="height:3px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 14px;font-size:19px;color:${NAVY};font-weight:700;">${heading}</h1>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">${lead}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
            <tr><td style="background:${NAVY};border-radius:7px;">
              <a href="${buttonHref}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">${buttonLabel}</a>
            </td></tr>
          </table>
          <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#64748B;">
            This link can be used once and expires ${expiry}. If the button does not work, copy this address into your browser:<br>
            <span style="color:${NAVY};word-break:break-all;">${buttonHref}</span>
          </p>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#64748B;border-top:1px solid #E2E8F0;padding-top:14px;">${footnote}</p>
        </td></tr>
        <tr><td style="background:#F8FAFC;padding:14px 28px;font-size:11px;color:#94A3B8;border-top:1px solid #E2E8F0;">
          Lake Cement Ltd. &middot; Nyati Cement &middot; This message was sent by the MIS. Please do not reply.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Each sender returns mailer.js's result — { sent:false, reason } when SMTP
   is not configured, rather than throwing. The caller decides whether that
   is fatal: creating a user without being able to email them is still a
   valid outcome, provided the admin is told the invite did not go out. */

async function sendInvite({ to, fullName, username, token }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  return sendMail({
    to,
    subject: 'Your Lake Cement MIS account',
    html: shell({
      heading: 'Set up your MIS account',
      lead: `Hello ${esc(fullName)},<br><br>An account has been created for you on the Lake Cement Management Information System. Choose your password to activate it. Your sign-in name is <strong>${esc(username)}</strong>.`,
      buttonLabel: 'Choose my password',
      buttonHref: `${base}/set-password.html?t=${encodeURIComponent(token)}&p=invite`,
      expiry: 'in 7 days',
      footnote: 'Nobody at Lake Cement, including IT, will know the password you choose. If you were not expecting this, tell the IT department.',
    }),
  });
}

async function sendReset({ to, fullName, token }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  return sendMail({
    to,
    subject: 'Reset your Lake Cement MIS password',
    html: shell({
      heading: 'Reset your password',
      lead: `Hello ${esc(fullName)},<br><br>We received a request to reset the password on your MIS account.`,
      buttonLabel: 'Choose a new password',
      buttonHref: `${base}/set-password.html?t=${encodeURIComponent(token)}&p=reset`,
      expiry: 'in 1 hour',
      footnote: 'If you did not ask for this, you can ignore this email — your current password still works and nothing has changed. If it keeps happening, tell the IT department.',
    }),
  });
}

async function sendVerify({ to, fullName, token }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  return sendMail({
    to,
    subject: 'Confirm your Lake Cement MIS email address',
    html: shell({
      heading: 'Confirm your email address',
      lead: `Hello ${esc(fullName)},<br><br>Please confirm this is the right address for your MIS account. It is where password resets and the daily plant reports will be sent.`,
      buttonLabel: 'Confirm this address',
      buttonHref: `${base}/verify-email.html?t=${encodeURIComponent(token)}`,
      expiry: 'in 14 days',
      footnote: 'Confirming only proves the address reaches you. It does not change your password or your access.',
    }),
  });
}

module.exports = { sendInvite, sendReset, sendVerify, appUrl };
