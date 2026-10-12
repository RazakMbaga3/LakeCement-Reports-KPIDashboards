/*
  services/complianceMail.js — the renewal reminder email.

  One email per recipient per run. Exactly one item gives the format the
  brief asked for:
      Subject  Compliance Renewal Reminder: Business License - HO
      Body     Compliance Name, Department, Expiry Date, Status
      Button   RENEW NOW  → that record in the Compliance Master
      Footer   an automated message from the Compliance Master System
  A filing ("Compliance Filing Reminder", RECORD FILING) and a standing
  condition ("Compliance Review Reminder", RECORD REVIEW) say what is
  actually asked of the reader. Several items for one person become one
  consolidated email, overdue first — a calibration officer with 24 TBS
  certificates expiring the same day gets one email, not 24.

  The button links to APP_URL/compliance.html?item=<id>. With APP_URL unset
  the email still goes, without buttons, rather than with a link to the
  wrong host (the rule services/mailLayout.js states).
*/
const { shell, esc, appUrl, buttonHTML, NAVY } = require('./mailLayout');
const { fmtDate } = require('./complianceStatus');

const SYSTEM = 'Compliance Master System';
const FOOTER = `Automated message from the <strong>${SYSTEM}</strong> &middot; Lake Cement Ltd. &middot; Nyati Cement. Please do not reply to this email.`;

const KIND = {
  validity:  { subject: 'Compliance Renewal Reminder', button: 'RENEW NOW',     dateLabel: 'Expiry Date', noun: 'licence or certificate' },
  recurring: { subject: 'Compliance Filing Reminder',  button: 'RECORD FILING', dateLabel: 'Due Date',    noun: 'filing or payment' },
  condition: { subject: 'Compliance Review Reminder',  button: 'RECORD REVIEW', dateLabel: 'Review Due',  noun: 'standing obligation' },
};
const ROLE_LABEL = { direct: 'Responsible person', second: 'Supervisor', head: 'Head (escalation)' };

function statusPhrase(e) {
  if (e.status === 'overdue') {
    if (e.kind === 'condition' && e.condition_result === 'not_complied') return 'Not complied';
    const n = e.days_left == null ? null : -e.days_left;
    return n ? `Overdue by ${n} day${n === 1 ? '' : 's'}` : 'Overdue';
  }
  if (e.days_left === 0) return 'Due today';
  if (e.days_left != null) return `Due in ${e.days_left} day${e.days_left === 1 ? '' : 's'}`;
  return e.status === 'due' ? 'Due' : 'Active';
}
const statusColour = e => (e.status === 'overdue' ? '#B42318' : '#9A6700');

function itemLink(base, id) { return base ? `${base}/compliance.html?item=${encodeURIComponent(id)}` : null; }

function detailRow(k, v) {
  return `<tr><td style="padding:7px 12px 7px 0;font-size:13px;color:#64748B;white-space:nowrap;vertical-align:top;">${k}</td>
              <td style="padding:7px 0;font-size:13px;color:#0F172A;font-weight:600;">${v}</td></tr>`;
}

/* entries: [{ id, title, kind, department, agency, reference_no, deadline,
              days_left, status, condition_result, renewal_in_progress,
              renewal_note, audience }] for ONE recipient. */
function composeReminder({ recipientName, entries }) {
  const base = appUrl();
  const sorted = [...entries].sort((a, b) =>
    (a.status === 'overdue' ? 0 : 1) - (b.status === 'overdue' ? 0 : 1) || (a.days_left ?? 0) - (b.days_left ?? 0));
  const hello = recipientName ? `Hello ${esc(recipientName)},<br><br>` : '';

  if (sorted.length === 1) {
    const e = sorted[0];
    const k = KIND[e.kind] || KIND.validity;
    const link = itemLink(base, e.id);
    const dateTxt = e.deadline ? fmtDate(e.deadline) : 'Not set';
    const rows = [
      detailRow('Compliance Name', esc(e.title)),
      detailRow('Department', esc(e.department)),
      e.agency ? detailRow('Agency', esc(e.agency)) : '',
      e.reference_no ? detailRow('Reference', esc(e.reference_no)) : '',
      detailRow(k.dateLabel, esc(dateTxt)),
      detailRow('Status', `<span style="color:${statusColour(e)};">${esc(statusPhrase(e))}</span>`),
      e.renewal_in_progress ? detailRow('Renewal', esc(e.renewal_note || 'In progress')) : '',
      detailRow('Your role', esc(ROLE_LABEL[e.audience] || '')),
    ].join('');
    return {
      subject: `${k.subject}: ${e.title}`.slice(0, 250),
      html: shell({
        system: SYSTEM,
        heading: e.status === 'overdue' ? 'This compliance item is overdue' : 'A compliance item needs renewal',
        lead: `${hello}This ${k.noun} needs your attention.`,
        bodyHtml: `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;border-top:1px solid #E2E8F0;width:100%;">${rows}</table>`,
        buttonLabel: k.button, buttonHref: link, primaryButton: true,
        linkNote: link
          ? `If the button does not work, copy this address into your browser:<br><span style="color:${NAVY};word-break:break-all;">${link}</span>`
          : 'Open the Compliance Master in the MIS to update this record.',
        footnote: 'You receive this because you are named on this compliance record. When the renewal is done, upload the new certificate on the record and the reminders stop.',
        footer: FOOTER,
      }),
    };
  }

  const overdueN = sorted.filter(e => e.status === 'overdue').length;
  const rows = sorted.map(e => {
    const k = KIND[e.kind] || KIND.validity;
    const link = itemLink(base, e.id);
    return `<tr>
      <td style="padding:10px 10px 10px 0;border-bottom:1px solid #E2E8F0;vertical-align:top;">
        <div style="font-size:13px;font-weight:700;color:#0F172A;">${esc(e.title)}</div>
        <div style="font-size:12px;color:#64748B;margin-top:2px;">${esc(e.department)}${e.agency ? ' &middot; ' + esc(e.agency) : ''} &middot; ${esc(ROLE_LABEL[e.audience] || '')}</div>
      </td>
      <td style="padding:10px 10px;border-bottom:1px solid #E2E8F0;vertical-align:top;font-size:12px;color:#334155;white-space:nowrap;">${esc(k.dateLabel)}<br><strong>${esc(e.deadline ? fmtDate(e.deadline) : 'Not set')}</strong></td>
      <td style="padding:10px 0 10px 10px;border-bottom:1px solid #E2E8F0;vertical-align:top;font-size:12px;font-weight:700;color:${statusColour(e)};white-space:nowrap;">${esc(statusPhrase(e))}
        ${link ? `<div style="margin-top:6px;"><a href="${link}" style="color:${NAVY};font-weight:800;text-decoration:underline;">${k.button}</a></div>` : ''}</td>
    </tr>`;
  }).join('');
  const open = base ? `${base}/compliance.html?view=mine` : null;
  return {
    subject: `Compliance Reminder: ${sorted.length} items need attention${overdueN ? ` (${overdueN} overdue)` : ''}`,
    html: shell({
      system: SYSTEM, wide: true,
      heading: `${sorted.length} compliance items need attention`,
      lead: `${hello}These records you are named on are due for renewal${overdueN ? ', and some are already overdue' : ''}.`,
      bodyHtml: `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 22px;border-top:1px solid #E2E8F0;">${rows}</table>`,
      buttonLabel: 'OPEN MY ITEMS', buttonHref: open, primaryButton: true,
      linkNote: open ? null : 'Open the Compliance Master in the MIS to update these records.',
      footnote: 'You receive this because you are named on these compliance records. Upload the renewed certificate (or record the filing) on each record and its reminders stop.',
      footer: FOOTER,
    }),
  };
}

module.exports = { composeReminder, SYSTEM, statusPhrase, _buttonHTML: buttonHTML };
