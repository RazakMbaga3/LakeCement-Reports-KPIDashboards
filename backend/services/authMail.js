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
const layout = require('./mailLayout');

const { NAVY, appUrl, esc } = layout;

/* The shared letterhead (services/mailLayout.js) plus the one thing every
   account email says: the link is single-use and expires. */
function shell({ heading, lead, buttonLabel, buttonHref, footnote, expiry }) {
  return layout.shell({
    heading, lead, buttonLabel, buttonHref, footnote,
    linkNote: `This link can be used once and expires ${expiry}. If the button does not work, copy this address into your browser:<br>
            <span style="color:${NAVY};word-break:break-all;">${buttonHref}</span>`,
  });
}

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
