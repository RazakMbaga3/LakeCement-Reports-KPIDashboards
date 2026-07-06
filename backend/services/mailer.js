/*
  services/mailer.js — one transport for everything that emails
  (digest.js, watchdog.js). SMTP settings live in .env; when SMTP_HOST is
  empty, mail silently no-ops unless DIGEST_TRANSPORT=json, which swaps in
  nodemailer's jsonTransport so tests can exercise the full pipeline
  without a mail server.
*/

const nodemailer = require('nodemailer');

function makeTransport() {
  if (process.env.SMTP_HOST) {
    return { kind: 'smtp', t: nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    }) };
  }
  if (process.env.DIGEST_TRANSPORT === 'json') {
    return { kind: 'json', t: nodemailer.createTransport({ jsonTransport: true }) };
  }
  return null;
}

/* Send an HTML mail to a comma-separated recipient list.
   Returns { sent, reason? , transport?, to?, message? } — never throws
   for "not configured"; real SMTP errors do propagate to the caller. */
async function sendMail({ subject, html, to }) {
  const list = (to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { sent: false, reason: 'no recipients configured' };

  const transport = makeTransport();
  if (!transport) return { sent: false, reason: 'SMTP not configured' };

  const info = await transport.t.sendMail({
    from: process.env.SMTP_FROM || 'mis@lakecement.co.tz',
    to: list.join(', '),
    subject, html,
  });

  return {
    sent: true, transport: transport.kind, to: list, subject,
    message: transport.kind === 'json' ? JSON.parse(info.message) : undefined,
  };
}

module.exports = { sendMail, makeTransport };
