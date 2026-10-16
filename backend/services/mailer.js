/*
  services/mailer.js — one transport for everything that emails
  (authMail.js, digest.js, watchdog.js). First match wins:

    DIGEST_TRANSPORT=json      nodemailer's jsonTransport. Checked first
                               because it is an explicit ask: the acceptance
                               scripts load the real .env and set this so a
                               test run never delivers real mail.
    GRAPH_TENANT_ID +          Microsoft Graph sendMail, as SMTP_FROM. The
    GRAPH_CLIENT_ID +          M365 tenant blocks SMTP AUTH (RAID R-6);
    GRAPH_CLIENT_SECRET        Graph is the route it permits.
    SMTP_HOST                  plain SMTP.

  With none of these, nothing sends and sendMail returns { sent:false }.
*/

const nodemailer = require('nodemailer');

const DEFAULT_FROM = 'digital@lakecement.co.tz';

function graphConfig() {
  const { GRAPH_TENANT_ID: tenant, GRAPH_CLIENT_ID: clientId, GRAPH_CLIENT_SECRET: secret } = process.env;
  return tenant && clientId && secret ? { tenant, clientId, secret } : null;
}

/* A token lasts an hour; fetching one per email would double every send's
   latency and hammer the token endpoint during a bulk invite. */
let tokenCache = null;

/* fetch() failures carry no `code`, and sendMail's `reason` is built from
   one — give network failures the same short codes nodemailer would. */
async function graphFetch(url, init, timeoutMs) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = err.name === 'TimeoutError' ? 'ETIMEDOUT' : (err.cause && err.cause.code) || 'ENETWORK';
    throw Object.assign(new Error(`Graph request failed: ${err.message}`), { code, cause: err });
  }
}

async function graphToken({ tenant, clientId, secret }) {
  const key = `${tenant}|${clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt > Date.now() + 60 * 1000) {
    return tokenCache.token;
  }
  const r = await graphFetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  }, 10 * 1000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw Object.assign(new Error(j.error_description || `token request failed (HTTP ${r.status})`),
      { code: j.error || `HTTP ${r.status}` });
  }
  tokenCache = { key, token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

function graphTransport(cfg) {
  return { kind: 'graph', t: {
    /* Graph takes ONE body, not a multipart alternative — `contentType:
       HTML` or `Text`, never both. So the plain-text part cannot ride along
       on this transport the way it does over SMTP; `text` is accepted and
       ignored here rather than silently changing the body type. The HTML is
       built to degrade to readable text on its own (table layout, real
       text, no image dependency), which is why that is survivable. */
    async sendMail({ from, fromName, to, subject, html }) {
      const token = await graphToken(cfg);
      const r = await graphFetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: to.map(address => ({ emailAddress: { address } })),
          /* Same mailbox, so no SendAs right is involved; Exchange may still
             show the mailbox's own display name instead of this one. */
          ...(fromName ? { from: { emailAddress: { address: from, name: fromName } } } : {}),
        } }),
      }, 30 * 1000);
      if (r.status === 202) return {};
      if (r.status === 401) tokenCache = null;
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error((j.error && j.error.message) || `sendMail failed (HTTP ${r.status})`),
        { code: (j.error && j.error.code) || `HTTP ${r.status}` });
    },
  } };
}

function makeTransport() {
  if (process.env.DIGEST_TRANSPORT === 'json') {
    return { kind: 'json', t: nodemailer.createTransport({ jsonTransport: true }) };
  }
  const graph = graphConfig();
  if (graph) return graphTransport(graph);
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
  return null;
}

/* True when a real delivery route is set up — what the admin page's
   invite-readiness check and the digest schedule should key off. */
function mailConfigured() {
  return !!(graphConfig() || process.env.SMTP_HOST);
}

/* Send an HTML mail to a comma-separated recipient list.
   Returns { sent, reason?, transport?, to?, message? } and NEVER
   throws — not for "not configured", and not for a transport or
   authentication failure either. Callers all branch on `sent`, and a throw
   skipped that branch: POST /api/auth/forgot-password was 500-ing on a
   known address while answering 200 for an unknown one, which turned it
   into an address-enumeration oracle (RAID R-7).

   `reason` is deliberately safe to put in a response: a short phrase plus
   the transport's error code (EAUTH, ETIMEDOUT, 535, ErrorAccessDenied …),
   because several admin endpoints already relay it. The server's raw error
   message — which can name internal hosts, mailboxes or tenant policy — is
   logged here and goes no further, since three callers hand their whole
   result straight to res.json(). */
/* `fromName` (optional) is the sender's display name — "Compliance Master
   System" for the compliance reminders; the address is always SMTP_FROM.

   `text` (optional) is the plain-text alternative. Over SMTP it becomes the
   text/plain part of a multipart/alternative — read by text-mode clients
   and screen readers, and weighed by spam gateways, which mark an
   HTML-only message down. Microsoft Graph carries a single body and cannot
   take it (see graphTransport above), so it is passed and dropped there;
   pass it anyway, so the day the transport changes nothing needs editing. */
async function sendMail({ subject, html, text, to, fromName }) {
  const list = (to || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return { sent: false, reason: 'no recipients configured' };

  const transport = makeTransport();
  if (!transport) return { sent: false, reason: 'mail not configured' };

  let info;
  try {
    const address = process.env.SMTP_FROM || DEFAULT_FROM;
    info = await transport.t.sendMail(transport.kind === 'graph'
      ? { from: address, fromName, to: list, subject, html }
      : { from: fromName ? { name: fromName, address } : address, to: list, subject, html,
          ...(text ? { text } : {}) });
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

module.exports = { sendMail, makeTransport, mailConfigured };
