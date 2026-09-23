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
      /* Nodemailer's own defaults are two minutes to connect and ten of
         socket silence — sized for a batch job, not for a request handler.
         A blocked outbound port (common on a fresh host) would otherwise
         hold a forgot-password request, or routes/admin.js's invite and the
         Postgres transaction it keeps open across the send, for the full
         two minutes. Fail in seconds instead and let the caller's
         { sent: false } handling run. */
      connectionTimeout: 10 * 1000,
      greetingTimeout:   10 * 1000,
      socketTimeout:     30 * 1000,
    }) };
  }
  if (process.env.DIGEST_TRANSPORT === 'json') {
    return { kind: 'json', t: nodemailer.createTransport({ jsonTransport: true }) };
  }
  return null;
}

/* Send an HTML mail to a comma-separated recipient list.
   Returns { sent, reason?, transport?, to?, message? } and NEVER
   throws — not for "not configured", and not for a transport or
   authentication failure either. Callers all branch on `sent`, and a throw
   skipped that branch: POST /api/auth/forgot-password was 500-ing on a
   known address while answering 200 for an unknown one, which turned it
   into an address-enumeration oracle (RAID R-7).

   `reason` is deliberately safe to put in a response: a short phrase plus
   the transport's error code (EAUTH, ETIMEDOUT, 535 …), because several
   admin endpoints already relay it. The server's raw error message — which
   can name internal hosts, mailboxes or tenant policy — is logged here and
   goes no further, since three callers hand their whole result straight to
   res.json(). */
async function sendMail({ subject, html, to }) {
  const list = (to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { sent: false, reason: 'no recipients configured' };

  const transport = makeTransport();
  if (!transport) return { sent: false, reason: 'SMTP not configured' };

  let info;
  try {
    info = await transport.t.sendMail({
      from: process.env.SMTP_FROM || 'digital@lakecement.co.tz',
      to: list.join(', '),
      subject, html,
    });
  } catch (err) {
    /* Required lazily: services/logger.js opens pino's rotating-file
       transport on require, and mailer.js is pulled into `node --test`
       runs and one-shot scripts that should not spin one up just to send
       through jsonTransport. */
    const code = err.code || err.responseCode || 'send failed';
    try {
      require('./logger').error(
        { err, code, transport: transport.kind, to: list, subject },
        'mail send failed');
    } catch { /* logging must never be the thing that breaks a send path */ }
    return {
      sent: false,
      reason: `the mail server rejected the message (${code})`,
      transport: transport.kind,
      to: list,
    };
  }

  return {
    sent: true, transport: transport.kind, to: list, subject,
    message: transport.kind === 'json' ? JSON.parse(info.message) : undefined,
  };
}

module.exports = { sendMail, makeTransport };
