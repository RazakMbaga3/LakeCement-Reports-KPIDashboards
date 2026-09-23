/*
  test/mailer.test.js — mailer.js's contract with its callers: on a transport
  failure it RETURNS, it does not throw.

  This is the one property none of the existing mail tests cover.
  test/auth-mail.test.js goes through jsonTransport or the missing-APP_URL
  branch, so it never reaches a transport at all — all six of its cases
  passed before the R-7 fix as well as after, which means they prove nothing
  about it. sendMail used to throw when SMTP rejected the message, and
  POST /api/auth/forgot-password answered 500 for an address that exists and
  200 for one that doesn't: an address-enumeration oracle (RAID R-7). Two
  other callers (routes/admin.js's invite, services/watchdog.js) branch on
  `sent` and quietly did the wrong thing on a throw too.

  So this file stands up a real SMTP socket that rejects AUTH exactly the way
  the Lake Cement tenant does today — 535 5.7.139, SmtpClientAuthentication
  is disabled (RAID R-6) — and asserts what comes back out of sendMail.

  No mail server, no network: the listener is on 127.0.0.1 and an ephemeral
  port, so it cannot collide with anything else running.

  Usage: node --test test/mailer.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const net    = require('net');
const path   = require('path');

/* mailer.js lazily requires services/logger.js when a send fails, and that
   module opens pino's rotating-file transport on a worker thread — a real
   log file and a live thread, from a unit test, as a side effect of the
   exact branch under test. Its own comment says it is lazy precisely so
   `node --test` doesn't do this. Seeding the module cache with a collector
   keeps that promise and lets the test assert what was logged. */
const LOGGER = require.resolve('../services/logger');
const logged = [];
require.cache[LOGGER] = {
  id: LOGGER, filename: LOGGER, path: path.dirname(LOGGER), loaded: true, children: [], paths: [],
  exports: { error: (obj, msg) => logged.push({ obj, msg }), warn: () => {}, info: () => {} },
};

const { sendMail } = require('../services/mailer');

/* Verbatim from the tenant, including the bits that must never reach a
   client: an internal Exchange hostname and a session id. */
const RAW_535 = '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant. '
  + 'Visit https://aka.ms/smtp_auth_disabled for more information. '
  + '[AM9PR01CA0012.eurprd01.prod.exchangelabs.com 2026-09-14T19:00:00.000Z 08DD1E2F3A4B5C6D]';

let server, port, savedEnv;

test.before(async () => {
  savedEnv = { ...process.env };
  server = net.createServer((sock) => {
    sock.write('220 fake.internal ESMTP ready\r\n');
    sock.on('data', (d) => {
      const line = d.toString();
      if (/^(EHLO|HELO)/i.test(line))   sock.write('250-fake.internal\r\n250 AUTH LOGIN PLAIN\r\n');
      else if (/^AUTH/i.test(line))     sock.write(RAW_535 + '\r\n');
      else if (/^QUIT/i.test(line))     { sock.write('221 bye\r\n'); sock.end(); }
      else                              sock.write('250 ok\r\n');
    });
    sock.on('error', () => { /* the client hangs up on 535; not a test failure */ });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  delete process.env.DIGEST_TRANSPORT;   // force real SMTP, not jsonTransport
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_USER = 'probe@example.test';
  process.env.SMTP_PASS = 'not-a-real-password';
  process.env.SMTP_FROM = 'digital@lakecement.co.tz';
});

test.after(async () => {
  await new Promise(r => server.close(r));
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

test('a 535 rejection comes back as { sent:false } — it does not throw', async () => {
  logged.length = 0;
  let result, threw = null;
  try {
    result = await sendMail({ subject: 'test', html: '<p>x</p>', to: 'someone@lakecement.co.tz' });
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null,
    'a throw here skips every caller\'s `if (!sent)` branch — that is what made forgot-password an enumeration oracle (R-7)');
  assert.equal(result.sent, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'the caller has to have something to show or log');
});

test('the reason is safe to put in a response — the code, not the server\'s text', async () => {
  const r = await sendMail({ subject: 'test', html: '<p>x</p>', to: 'someone@lakecement.co.tz' });

  /* routes/monitor.js and routes/admin.js relay this string to admin/md/it
     users. The tenant's own message names an internal Exchange host and a
     session id; neither belongs in an HTTP response. */
  assert.doesNotMatch(r.reason, /exchangelabs/i, 'must not leak the internal mail host');
  assert.doesNotMatch(r.reason, /aka\.ms/i,      'must not leak the vendor support URL verbatim');
  assert.doesNotMatch(r.reason, /SmtpClientAuthentication/i, 'must not leak tenant policy detail');
  assert.match(r.reason, /535|EAUTH/, 'but it must still say enough to diagnose: the code');
});

test('the raw server error is logged server-side, so nothing is lost', async () => {
  logged.length = 0;
  await sendMail({ subject: 'test', html: '<p>x</p>', to: 'someone@lakecement.co.tz' });
  assert.equal(logged.length, 1, 'a failed send must leave a trace for whoever debugs it');
  assert.match(logged[0].msg, /mail send failed/);
  assert.ok(logged[0].obj.err, 'the full error object belongs in the log, not the response');
});

test('nothing listening is a failure like any other — still no throw', async () => {
  const dead = net.createServer();
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise(r => dead.close(r));   // the port is now certainly closed

  process.env.SMTP_PORT = String(deadPort);
  try {
    const r = await sendMail({ subject: 'test', html: '<p>x</p>', to: 'someone@lakecement.co.tz' });
    assert.equal(r.sent, false);
    assert.match(r.reason, /ECONNREFUSED|ECONNECTION|ETIMEDOUT|ESOCKET/,
      'a blocked or closed outbound port must report as a send failure, not an exception');
  } finally {
    process.env.SMTP_PORT = String(port);
  }
});
