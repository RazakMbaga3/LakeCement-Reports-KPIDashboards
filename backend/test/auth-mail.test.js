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
process.env.SMTP_FROM = 'digital@lakecement.co.tz';
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
    assert.match(r.message.from.address, /digital@lakecement\.co\.tz/);
  });
});

/* ── the plain-text alternative ───────────────────────────────────────────
   Every account email carries one. It is what a text-mode client, a screen
   reader and the spam gateway read, and an HTML-only message scores worse
   at the gateway — so "the HTML looks right" is not enough. These assert
   the text part EXISTS, carries the same working link, and never leaks
   markup, because a text part built by hand is exactly the thing that
   rots silently when the HTML next changes. */
test('every account email carries a plain-text alternative with the same link', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const sends = [
      ['invite',     () => authMail.sendInvite({ to: TO, fullName: 'Godhania Natha', username: 'production_officer', token: TOKEN })],
      ['reminder',   () => authMail.sendActivationReminder({ to: TO, fullName: 'Sophia Mkassi', username: 'finance_officer', token: TOKEN })],
      ['reset',      () => authMail.sendReset({ to: TO, fullName: 'X', token: TOKEN })],
      ['verify',     () => authMail.sendVerify({ to: TO, fullName: 'X', token: TOKEN })],
    ];
    for (const [name, send] of sends) {
      const { message: m } = await send();
      assert.ok(m.text && m.text.length > 100, `${name}: a text part must exist and say something`);
      assert.ok(m.text.includes('https://mis.lakecement.co.tz/'),
        `${name}: the text part must carry the link, or it is useless to a text-mode reader`);
      assert.ok(m.text.includes(TOKEN), `${name}: the link in the text part must carry the token`);
      assert.ok(!/<[a-z/]/i.test(m.text), `${name}: the text part must not contain HTML tags`);
      assert.ok(!m.text.includes('&amp;') && !m.text.includes('&middot;'),
        `${name}: the text part must not contain HTML entities`);
      /* Nothing but the URL may exceed 72 columns, or Outlook's plain-text
         reader re-wraps the body into a ragged mess on a phone. */
      for (const line of m.text.split('\n')) {
        if (line.includes('://')) continue;
        assert.ok(line.length <= 72, `${name}: line over 72 cols: ${line}`);
      }
    }
  });
});

/* ── the welcome email ────────────────────────────────────────────────────
   This is the first thing ~47 staff ever see of the system (RAID I-45: 27
   of 50 real accounts have never been logged into), so the content is a
   requirement, not a preference. */
test('the welcome email answers what to do, in what name, and who to ask', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const { message: m } = await authMail.sendInvite({
      to: TO, fullName: 'Godhania Natha', username: 'production_officer', token: TOKEN });

    for (const part of [m.html, m.text]) {
      assert.ok(part.includes('production_officer'), 'tells them the name they sign in with');
      assert.ok(/draft/i.test(part) && /submit/i.test(part),
        'the draft-vs-submit trap is the single most costly thing a new user can get wrong');
      assert.ok(/department head/i.test(part), 'names a route to help that exists today');
    }
    /* Exactly one call to action. A second button splits the one decision
       this email exists to produce. */
    assert.equal((m.html.match(/set-password\.html/g) || []).length, 2,
      'one button plus one copy-paste fallback — no second competing action');
  });
});

test('a support contact, when confirmed, replaces the department-head fallback', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const { message: m } = await authMail.sendInvite({
      to: TO, fullName: 'X', username: 'y', token: TOKEN, supportLine: 'the IT Helpdesk on extension 214' });
    assert.ok(m.html.includes('the IT Helpdesk on extension 214'));
    assert.ok(m.text.includes('the IT Helpdesk on extension 214'));
  });
});

/* ── the activation reminder ──────────────────────────────────────────────
   A nudge, not a scolding. The wording is the deliverable here: this goes
   to someone who has already ignored one email, and blaming them is the
   one thing guaranteed to lose them. */
test('the activation reminder nudges without blaming, and repeats the whole instruction', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const { message: m } = await authMail.sendActivationReminder({
      to: TO, fullName: 'Sophia Mkassi', username: 'finance_officer', token: TOKEN });

    assert.ok(m.html.includes('p=invite'),
      'an activation reminder re-issues the invite, not a reset — the purposes have different lifetimes');
    assert.ok(m.html.includes('finance_officer'),
      'repeats the sign-in name rather than saying "see my previous email" — that email may be in junk');
    assert.ok(/you (can )?ignore this/i.test(m.html),
      'someone who has already activated must be told no action is needed');
    for (const scold of [/you (have )?(failed|did not|have not responded)/i, /reminder:/i, /urgent/i, /immediately/i]) {
      assert.ok(!scold.test(m.html), `blaming or shouting language must not appear: ${scold}`);
    }
  });
});

test('a second activation reminder changes its opening, not its instructions', async () => {
  await withAppUrl('https://mis.lakecement.co.tz', async () => {
    const first  = (await authMail.sendActivationReminder({ to: TO, fullName: 'X', username: 'y', token: TOKEN })).message;
    const second = (await authMail.sendActivationReminder({ to: TO, fullName: 'X', username: 'y', token: TOKEN, attempt: 2 })).message;
    assert.notEqual(first.html, second.html, 'the opening acknowledges this is not the first nudge');
    assert.equal(first.subject, second.subject);
    assert.ok(!/expired/i.test(second.html),
      'the second nudge cannot claim the previous link expired — it may not have');
  });
});

test('the activation reminder refuses to send without APP_URL, like every other account email', async () => {
  await withAppUrl(null, async () => {
    const r = await authMail.sendActivationReminder({ to: TO, fullName: 'X', username: 'y', token: TOKEN });
    assert.equal(r.sent, false);
    assert.match(r.reason, /APP_URL/);
  });
});
