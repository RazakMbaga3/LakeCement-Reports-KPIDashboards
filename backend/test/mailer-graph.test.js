/*
  test/mailer-graph.test.js — the Microsoft Graph route through mailer.js.

  The tenant blocks SMTP AUTH (RAID R-6), so Graph is how mail actually
  leaves. global fetch is replaced with a recorder: no network, and every
  request mailer.js makes is visible to the assertions.

  Usage: node --test test/mailer-graph.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const LOGGER = require.resolve('../services/logger');
require.cache[LOGGER] = {
  id: LOGGER, filename: LOGGER, path: path.dirname(LOGGER), loaded: true, children: [], paths: [],
  exports: { error: () => {}, warn: () => {}, info: () => {} },
};

delete process.env.DIGEST_TRANSPORT;
delete process.env.SMTP_HOST;
process.env.GRAPH_TENANT_ID     = 'tenant-1';
process.env.GRAPH_CLIENT_ID     = 'client-1';
process.env.GRAPH_CLIENT_SECRET = 'secret-1';
process.env.SMTP_FROM           = 'digital@lakecement.co.tz';

const { sendMail, makeTransport, mailConfigured } = require('../services/mailer');

let calls, sendReply;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
global.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  if (String(url).includes('/oauth2/v2.0/token')) return json(200, { access_token: 'tok-1', expires_in: 3599 });
  return sendReply();
};

test.beforeEach(() => {
  calls = [];
  sendReply = () => new Response(null, { status: 202 });
});

test('Graph is chosen when its three settings are present', () => {
  assert.equal(makeTransport().kind, 'graph');
  assert.equal(mailConfigured(), true);
});

test('DIGEST_TRANSPORT=json still wins, so a test run never delivers real mail', () => {
  process.env.DIGEST_TRANSPORT = 'json';
  try { assert.equal(makeTransport().kind, 'json'); }
  finally { delete process.env.DIGEST_TRANSPORT; }
});

test('a send posts to the sender mailbox with every recipient', async () => {
  const r = await sendMail({ subject: 'Digest', html: '<p>x</p>', to: 'md@lakecement.co.tz, ph@lakecement.co.tz' });
  assert.equal(r.sent, true);
  assert.equal(r.transport, 'graph');

  const send = calls.find(c => c.url.includes('/sendMail'));
  assert.match(send.url, /\/users\/digital%40lakecement\.co\.tz\/sendMail$/);
  assert.equal(send.init.headers.Authorization, 'Bearer tok-1');
  const body = JSON.parse(send.init.body);
  assert.equal(body.message.body.contentType, 'HTML');
  assert.deepEqual(body.message.toRecipients.map(t => t.emailAddress.address),
    ['md@lakecement.co.tz', 'ph@lakecement.co.tz']);
});

test('the token is reused across sends rather than fetched every time', async () => {
  await sendMail({ subject: 'a', html: 'a', to: 'x@lakecement.co.tz' });
  await sendMail({ subject: 'b', html: 'b', to: 'x@lakecement.co.tz' });
  assert.equal(calls.filter(c => c.url.includes('/token')).length, 0,
    'the token from the earlier test is still valid, so no token request at all');
  assert.equal(calls.filter(c => c.url.includes('/sendMail')).length, 2);
});

test('a Graph rejection returns { sent:false } with the code, not the message', async () => {
  sendReply = () => json(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again. tenant c616af68-internal' } });
  const r = await sendMail({ subject: 'x', html: 'x', to: 'x@lakecement.co.tz' });
  assert.equal(r.sent, false);
  assert.match(r.reason, /ErrorAccessDenied/);
  assert.doesNotMatch(r.reason, /c616af68|Check credentials/, 'Graph\'s own message stays in the log');
});

test('a network failure is a failure like any other — no throw', async () => {
  sendReply = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  const r = await sendMail({ subject: 'x', html: 'x', to: 'x@lakecement.co.tz' });
  assert.equal(r.sent, false);
  assert.match(r.reason, /ENOTFOUND/);
});
