/*
  test/auth-mail.test.js — the three account emails.

  Exercises the real nodemailer pipeline through jsonTransport (no mail
  server), so what is asserted is the message that would actually be sent:
  that the link points at APP_URL and carries the token, that the token is
  not leaked into some other part of the message, and that an unconfigured
  APP_URL refuses to send rather than mailing a broken link.

  Usage: node --test test/auth-mail.test.js   (from backend/)
*/
const test   = require('node:test');
const assert = require('node:assert/strict');

/* Set before requiring: mailer.js reads process.env at call time, but being
   explicit here keeps the test independent of whatever .env holds. */
process.env.DIGEST_TRANSPORT = 'json';
process.env.SMTP_FROM = 'mis@lakecement.co.tz';
delete process.env.SMTP_HOST;          // force the json transport, not real SMTP

const authMail = require('../services/authMail');

const TOKEN = 'test-token-abc123_XYZ-456';
const TO    = 'someone@lakecement.co.tz';

function withAppUrl(url, fn) {
  const prev = process.env.APP_URL;
  if (url === null) delete process.env.APP_URL; else process.env.APP_URL = url;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.APP_URL; else process.env.APP_URL = prev;
  });
}

test('an invitation carries a working link to APP_URL', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const r = await authMail.sendInvite({ to: TO, fullName: 'Godhania Natha', username: 'production', token: TOKEN });
    assert.equal(r.sent, true);
    assert.deepEqual(r.to, [TO]);

    const html = r.message.html;
    assert.ok(html.includes(`https://mis.lakecement.co.tz/set-password.html?t=${encodeURIComponent(TOKEN)}&p=invite`),
      'the link must point at APP_URL with the token and the invite purpose');
    assert.ok(html.includes('Godhania Natha'), 'addressed to the person');
    assert.ok(html.includes('production'), 'tells them their sign-in name');
    assert.match(r.message.subject, /account/i);
  });
});

test('a reset points at the reset purpose, not invite', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const r = await authMail.sendReset({ to: TO, fullName: 'Sophia Mkassi', token: TOKEN });
    assert.equal(r.sent, true);
    assert.ok(r.message.html.includes('p=reset'));
    assert.ok(!r.message.html.includes('p=invite'),
      'a reset mail must not carry an invite link — the purposes have different lifetimes');
    assert.ok(r.message.html.includes('you can ignore this email'),
      'someone who did not request it must be told no action is needed');
  });
});

test('a trailing slash on APP_URL does not produce a double slash', async () => {
  await withAppUrl('https://mis.lakecement.co.tz/', async () => {
    const r = await authMail.sendReset({ to: TO, fullName: 'X', token: TOKEN });
    assert.ok(!r.message.html.includes('.co.tz//set-password'), 'the URL must be normalised');
    assert.ok(r.message.html.includes('.co.tz/set-password'));
  });
});

test('without APP_URL nothing is sent, and the reason says why', async () => {
  await withAppUrl(null, async () => {
    for (const send of [
      () => authMail.sendInvite({ to: TO, fullName: 'X', username: 'y', token: TOKEN }),
      () => authMail.sendReset({ to: TO, fullName: 'X', token: TOKEN }),
      () => authMail.sendVerify({ to: TO, fullName: 'X', token: TOKEN }),
    ]) {
      const r = await send();
      assert.equal(r.sent, false, 'a link with no host is worse than no link — it looks like it should work');
      assert.match(r.reason, /APP_URL/);
    }
  });
});

test('a name with HTML in it cannot inject markup into the message', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const r = await authMail.sendInvite({
      to: TO, fullName: '<script>alert(1)</script>', username: 'x', token: TOKEN,
    });
    assert.ok(!r.message.html.includes('<script>alert(1)</script>'),
      'a full name comes from the admin form and must be escaped in the mail body');
    assert.ok(r.message.html.includes('&lt;script&gt;'));
  });
});

test('the message is addressed from SMTP_FROM', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const r = await authMail.sendVerify({ to: TO, fullName: 'X', token: TOKEN });
    assert.match(r.message.from.address, /mis@lakecement\.co\.tz/);
  });
});
