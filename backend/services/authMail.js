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

const { NAVY, ORANGE, appUrl, esc, textShell } = layout;

/* The shared letterhead (services/mailLayout.js) plus the one thing every
   account email says: the link is single-use and expires. */
function shell({ heading, lead, bodyHtml, buttonLabel, buttonHref, primaryButton,
                 footnote, expiry, preheader }) {
  return layout.shell({
    heading, lead, bodyHtml, buttonLabel, buttonHref, primaryButton, footnote, preheader,
    linkNote: `This link can be used once and expires ${expiry}. If the button does not work, copy this address into your browser:<br>
            <span style="color:${NAVY};word-break:break-all;">${buttonHref}</span>`,
  });
}

/* The plain-text twin of shell(). Same expiry sentence, same link, built
   from the same arguments so the two parts of one message cannot disagree
   about what the reader is being asked to do. */
function shellText({ heading, lines, buttonLabel, buttonHref, footnote, expiry }) {
  return textShell({
    heading, lines, url: buttonHref, urlLabel: buttonLabel,
    footnote: `This link can be used once and expires ${expiry}.\n${footnote}`,
  });
}

/* A numbered step. Table-based, not <ol>: Outlook's list rendering ignores
   margins and Gmail strips the list role on some Android builds, so the
   number is drawn as its own cell. The orange number is 13px bold on white
   — orange this small fails WCAG AA for text (2.9:1), so it is NEVER the
   only carrier of meaning: the step is in reading order and the words
   beside it say everything. Navy would read as a link; this is decoration
   doing decoration's job. */
function step(n, text) {
  return `<tr>
    <td width="26" valign="top" style="padding:0 0 12px;font-size:13px;font-weight:800;color:${ORANGE};line-height:1.55;">${n}.</td>
    <td valign="top" style="padding:0 0 12px;font-size:14px;line-height:1.55;color:#334155;">${text}</td>
  </tr>`;
}
const steps = rows =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 4px;">${rows.join('')}</table>`;

/* Each sender returns mailer.js's result — { sent:false, reason } when SMTP
   is not configured, rather than throwing. The caller decides whether that
   is fatal: creating a user without being able to email them is still a
   valid outcome, provided the admin is told the invite did not go out. */

/* ─────────────────────────────────────────────────────────────────────────
   INVITE — the welcome email.

   This is the first and possibly only thing ~47 plant staff will ever see
   of this system, and 27 of 50 real accounts have never been logged into
   (RAID I-45), so the email is the whole onboarding. It answers five
   questions in the order a reader asks them — what is this, why me, what do
   I do, what will I use it for, who helps me — and nothing else. No
   feature tour, no benefits paragraph: a reader on a plant connection who
   scrolls has already lost the thread.

   Deliberately NOT in here:
   - the password rules (they are on set-password.html, where they can be
     validated live; printing them twice invites them to diverge)
   - a training date or a support name, because neither is confirmed
     (docs/launch/COMMUNICATIONS.md keeps both as placeholders, and
     SUPPORT_AND_INCIDENTS.md:7 — "a support process with no named route is
     not a support process"). supportLine is therefore a parameter, and the
     email falls back to "your department head" — a route that exists today.
   ──────────────────────────────────────────────────────────────────────── */
const DEFAULT_SUPPORT = 'your department head';

function inviteBody({ username, supportLine }) {
  const help = supportLine || DEFAULT_SUPPORT;
  return {
    html: steps([
      step(1, 'Press the button below and choose your own password.'),
      step(2, `Sign in with your name <strong style="color:${NAVY};">${esc(username)}</strong> and that password.`),
      step(3, 'Open your department\'s daily report and fill it in as usual.'),
    ]) + `<p style="margin:16px 0 20px;font-size:14px;line-height:1.6;color:#334155;">
        You will use it to file the daily report your department already produces — the figures are the same, only the place you type them changes. Your head approves it, and the KPIs and management reports build themselves from there.
      </p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">
        <strong>One thing to remember:</strong> saving a draft is not the same as submitting. Always press <strong>Submit</strong> when you have finished, or the report has not been filed.
      </p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">
        Stuck, or something looks wrong? Ask ${esc(help)}. Tell us early rather than working around it.
      </p>`,
    /* One string per paragraph — mailLayout.wrap72 does the wrapping, so a
       long supportLine cannot push a line past 72 columns. Leading spaces
       on the steps are preserved across wraps. */
    text: [
      'An account has been created for you on the Lake Cement Management Information System (the MIS) — the system the plant now files its daily reports in. You are getting this because your department records or approves one of those reports.',
      '',
      'WHAT TO DO — three steps:',
      '  1. Open the link below and choose your own password.',
      `  2. Sign in with your name "${username}" and that password.`,
      '  3. Open your department\'s daily report and fill it in as usual.',
      '',
      'You will use it to file the daily report your department already produces. The figures are the same; only the place you type them changes. Your head approves it, and the KPIs and management reports build themselves from there.',
      '',
      'ONE THING TO REMEMBER: saving a draft is not the same as submitting. Always press Submit when you have finished, or the report has not been filed.',
      '',
      `Stuck, or something looks wrong? Ask ${help}. Tell us early rather than working around it.`,
    ],
  };
}

async function sendInvite({ to, fullName, username, token, supportLine }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  const href = `${base}/set-password.html?t=${encodeURIComponent(token)}&p=invite`;
  const body = inviteBody({ username, supportLine });
  const expiry = 'in 7 days';
  const footnote = 'Nobody at Lake Cement, including IT, will know the password you choose. If you were not expecting this, tell the IT department.';
  return sendMail({
    to,
    /* Names the person's own task, not the system's. "Your Lake Cement MIS
       account" reads like a statement about a thing; this reads like
       something to do, which is what the open rate turns on. */
    subject: 'Set up your account for the plant reporting system',
    html: shell({
      heading: 'Welcome — set up your account',
      preheader: 'Choose your password, then file your department\'s daily report in one place.',
      lead: `Hello ${esc(fullName)},<br><br>An account has been created for you on the Lake Cement <strong>Management Information System</strong> — the system the plant now files its daily reports in. You are getting this because your department records or approves one of those reports.`,
      bodyHtml: body.html,
      buttonLabel: 'Choose my password',
      /* The one orange button in the set. Orange is the action colour here
         and nowhere else in the message, so there is no competition for
         "what do I press" — the reset and verify mails stay navy. */
      primaryButton: true,
      buttonHref: href,
      expiry, footnote,
    }),
    text: shellText({
      heading: 'Welcome — set up your account',
      lines: [`Hello ${fullName},`, '', ...body.text],
      buttonLabel: 'Choose your password here',
      buttonHref: href, expiry, footnote,
    }),
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   ACTIVATION REMINDER — for someone invited who never acted.

   A nudge, not a scolding: it never says "you failed to", never counts the
   days, and gives the benefit of the doubt in its first line (the old link
   expiring is a fact, and it is also a face-saving reason to not have
   acted). It repeats the whole instruction rather than saying "see my
   previous email", because the previous email may well have gone to a
   junk folder — and because RAID I-50 means early invites carried a bare
   `http://` IP link that staff were right not to click.

   `attempt` only changes the opening sentence. There is no third template:
   if two of these do not land, the answer is a person walking over to them,
   not a third email. ──────────────────────────────────────────────────── */
async function sendActivationReminder({ to, fullName, username, token, supportLine, attempt = 1 }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  const href = `${base}/set-password.html?t=${encodeURIComponent(token)}&p=invite`;
  const help = supportLine || DEFAULT_SUPPORT;
  const expiry = 'in 7 days';
  const footnote = 'If you have already set your password and signed in, nothing is needed — you can ignore this message.';
  const opener = attempt > 1
    ? 'Your account on the plant reporting system is still waiting to be set up. Here is a fresh link.'
    : 'Your account on the plant reporting system is ready, but it has not been set up yet. The first link we sent has expired, so here is a new one.';

  return sendMail({
    to,
    subject: 'Your account is waiting — one step to finish',
    html: shell({
      heading: 'Your account is still waiting',
      preheader: 'One step: choose a password. The link below is new and works for 7 days.',
      lead: `Hello ${esc(fullName)},<br><br>${opener}`,
      bodyHtml: steps([
        step(1, 'Press the button below and choose your own password.'),
        step(2, `Sign in with your name <strong style="color:${NAVY};">${esc(username)}</strong>.`),
      ]) + `<p style="margin:16px 0 20px;font-size:14px;line-height:1.6;color:#334155;">
          It takes about a minute. Until it is done you cannot file your department's daily report, and the days you have not filed show as missing in the management reports.
        </p>
        <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">
          If you would rather someone walked you through it, ask ${esc(help)} — that is a perfectly normal request and quicker than working it out alone.
        </p>`,
      buttonLabel: 'Set up my account',
      primaryButton: true,
      buttonHref: href,
      expiry, footnote,
    }),
    text: shellText({
      heading: 'Your account is still waiting',
      lines: [
        `Hello ${fullName},`, '', opener, '',
        'WHAT TO DO:',
        '  1. Open the link below and choose your own password.',
        `  2. Sign in with your name "${username}".`,
        '',
        'It takes about a minute. Until it is done you cannot file your department\'s daily report, and the days you have not filed show as missing in the management reports.',
        '',
        `If you would rather someone walked you through it, ask ${help} — that is a perfectly normal request and quicker than working it out alone.`,
      ],
      buttonLabel: 'Set up your account here',
      buttonHref: href, expiry, footnote,
    }),
  });
}

async function sendReset({ to, fullName, token }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  const href = `${base}/set-password.html?t=${encodeURIComponent(token)}&p=reset`;
  const expiry = 'in 1 hour';
  const footnote = 'If you did not ask for this, you can ignore this email — your current password still works and nothing has changed. If it keeps happening, tell the IT department.';
  const lead = 'We received a request to reset the password on your MIS account.';
  return sendMail({
    to,
    subject: 'Reset your Lake Cement MIS password',
    html: shell({
      heading: 'Reset your password',
      preheader: 'Choose a new password. This link works for one hour.',
      lead: `Hello ${esc(fullName)},<br><br>${lead}`,
      buttonLabel: 'Choose a new password',
      buttonHref: href, expiry, footnote,
    }),
    text: shellText({
      heading: 'Reset your password',
      lines: [`Hello ${fullName},`, '', lead],
      buttonLabel: 'Choose a new password here',
      buttonHref: href, expiry, footnote,
    }),
  });
}

async function sendVerify({ to, fullName, token }) {
  const base = appUrl();
  if (!base) return { sent: false, reason: 'APP_URL is not configured, so no link could be built' };
  const href = `${base}/verify-email.html?t=${encodeURIComponent(token)}`;
  const expiry = 'in 14 days';
  const footnote = 'Confirming only proves the address reaches you. It does not change your password or your access.';
  const lead = 'Please confirm this is the right address for your MIS account. It is where password resets and the daily plant reports will be sent.';
  return sendMail({
    to,
    subject: 'Confirm your Lake Cement MIS email address',
    html: shell({
      heading: 'Confirm your email address',
      preheader: 'One click to confirm this address receives your MIS mail.',
      lead: `Hello ${esc(fullName)},<br><br>${lead}`,
      buttonLabel: 'Confirm this address',
      buttonHref: href, expiry, footnote,
    }),
    text: shellText({
      heading: 'Confirm your email address',
      lines: [`Hello ${fullName},`, '', lead],
      buttonLabel: 'Confirm this address here',
      buttonHref: href, expiry, footnote,
    }),
  });
}

module.exports = { sendInvite, sendReset, sendVerify, sendActivationReminder, appUrl };
