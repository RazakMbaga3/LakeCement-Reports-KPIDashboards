/*
  services/complianceImport.js — reads "1. Compliance Master.xlsx" into
  compliance_* rows.

  Two visible sheets are read; the hidden ones (HO, Plant, Land & Mining,
  BRL, UCL, MASTER (2)) are older drafts and are ignored on purpose.

    "Compliance Master - Operations"  one obligation per row, 17 columns
    "Compliance Matser - Mining"      (sic) four licence blocks, each a
                                      header (License No., Location, Type,
                                      Resource, Sq.Km) then its obligations

  THE RULE IS HONESTY, NOT TIDINESS. The workbook's Status column is not
  imported as a status — status is computed from the dates (see
  services/complianceStatus.js), so a row the sheet calls "Active" whose
  "To" date passed in 2025 comes in Overdue. Every row comes in Unverified;
  the owning department confirms it in the app. Nothing is guessed: a cell
  that cannot be read honestly (the 1905 "dates", a To column that just
  says "Yearly") becomes a blank plus a warning, never an invented date.

  Every non-blank row is classified exactly once — item, child item, group
  header, structural, or skipped with a reason — and the reconciliation
  block proves the classes add up to the sheet.

  parseComplianceWorkbook() is pure apart from reading the buffer;
  planImport() / commitImport() take a pg client.
*/
const crypto  = require('crypto');
const ExcelJS = require('exceljs');
const { roleForSection, normSection, AMBIGUOUS_SECTIONS, OWNER_ROLES } = require('../config/complianceDepartments');
const { todayIn, addDays, periodKey } = require('./complianceStatus');

/* ── Cells ────────────────────────────────────────────────────────────── */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    if (v.result !== undefined) return cellValue(v.result);
    if (v.text !== undefined) return String(v.text);
    if (v.formula !== undefined || v.sharedFormula !== undefined) return null;
    return null;
  }
  return v;
}
function text(v) {
  const c = cellValue(v);
  if (c === null) return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ── Dates ────────────────────────────────────────────────────────────
   Returns { date, warn } — date 'YYYY-MM-DD' or null. Date cells are read
   in UTC (exceljs stores them as UTC midnights). Text accepts dd.mm.yyyy,
   dd/mm/yyyy, dd-mm-yyyy, dd/mm/yy and "1st Jan 23". A year before 1990 is
   refused: in this workbook those are years typed into a date-formatted
   cell — "2019" becomes 1905-07-11 because 2019 is that date's serial
   number — so the honest reading is "year YYYY, day and month unknown". */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
function validYmd(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}
function excelSerialYear(dt) {
  // 1900 date system: serial 1 = 1900-01-01 (with the 1900 leap-year bug).
  const serial = Math.round((dt.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
  return serial;
}
function parseDate(raw) {
  const v = cellValue(raw);
  if (v === null || v === '') return { date: null };
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    if (y < 1990 || y > 2100) {
      const serial = excelSerialYear(v);
      const looksLikeYear = serial >= 1990 && serial <= 2100;
      return { date: null, warn: looksLikeYear
        ? `"${y}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}" is the year ${serial} typed into a date cell — day and month unknown, left blank`
        : `implausible date ${v.toISOString().slice(0, 10)} — left blank` };
    }
    return { date: validYmd(y, v.getUTCMonth() + 1, v.getUTCDate()), isCell: true, cell: v };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = validYmd(y, +m[2], +m[1]);
    if (d && y >= 1990 && y <= 2100) return { date: d };
    return { date: null, warn: `could not read "${s}" as a date — left blank` };
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})$/);
  const mon = m && MON[m[2].slice(0, 3).toLowerCase()];
  if (mon) {
    let y = +m[3]; if (y < 100) y += 2000;
    const d = validYmd(y, mon, +m[1]);
    if (d) return { date: d };
  }
  return { date: null, text: s };
}

/* ── Small parsers ────────────────────────────────────────────────────── */
function parseLead(raw) {
  const m = text(raw).match(/(\d+)\s*days?/i);
  return m ? Math.min(365, +m[1]) : null;
}
function splitPeople(raw) {
  return text(raw).split(/\s*[/,&]\s*/).map(s => s.trim()).filter(s => s && !/^(-|na|n\/a)$/i.test(s));
}
/* Spellings of the same person across the two sheets. */
const PERSON_ALIASES = {
  'pss sajiv': 'Sajivkumar PS',
  'sajiv': 'Sajivkumar PS',
  'sajivkumar ps': 'Sajivkumar PS',
  'punit': 'Punit Aswala',
  'sankalp': 'Sankalp Jaithalia',
  'muneesh': 'Muneesh Kumar',
};
function canonicalPerson(name) {
  const k = name.toLowerCase().replace(/\s+/g, ' ').trim();
  return PERSON_ALIASES[k] || name.replace(/\s+/g, ' ').trim();
}
function parseFee(desc) {
  const m = String(desc || '').match(/(US\s*\$|USD|Tsh|TZS)\s*([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  return { amount: +m[2].replace(/,/g, ''), currency: /us|usd/i.test(m[1]) ? 'USD' : 'TZS' };
}
const RENEWAL_RE = /under renewal|pending with|inspection (is )?done|application (done|submitted)|applied/i;
function normCustodian(s) {
  const t = text(s);
  if (!t) return null;
  if (/^ho\s*\/\s*plant$/i.test(t)) return 'HO/Plant';
  return t.slice(0, 30);
}
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const keyPart = s => normSection(s);

/* Workbook status text → an assessment result (conditions, mining sheet). */
function assessmentFrom(statusText) {
  const s = String(statusText || '').trim();
  if (!s) return null;
  if (/not\s*complied/i.test(s)) return { result: 'not_complied' };
  if (/partially/i.test(s)) return { result: 'partial' };
  if (/^na$/i.test(s)) return { result: 'not_applicable' };
  if (/to be verified|under preparation|will be done|approved with conditions/i.test(s)) {
    return { result: 'partial', warn: `status "${s}" read as Partially complied` };
  }
  if (/^complied/i.test(s)) return { result: 'complied', note: s.length > 9 ? s : null };
  return null;
}

/* ── Titles ───────────────────────────────────────────────────────────────
   The description, made distinguishable: a generic description gets its
   agency, and a short qualifier from remarks ("Logo (Mark)", "Boundary
   Wall") is appended so two "Trade Mark Certificate" rows read apart. */
function makeTitle(desc, agency, remark) {
  let t = desc || agency || 'Untitled obligation';
  if (desc && desc.length < 24 && agency) {
    // "TAX CLEARANCE CERTIFICATE" / "For All Contractors": the document was
    // written in the agency column, so it leads the title.
    t = /certificate|licen[cs]e/i.test(agency) && !/certificate|licen[cs]e/i.test(desc)
      ? `${agency} — ${desc}` : `${desc} — ${agency}`;
  }
  if (remark && remark.length <= 30 && !RENEWAL_RE.test(remark) && !/^(na|-|\d+)$/i.test(remark)) t = `${t} (${remark.trim()})`;
  return t.length > 200 ? t.slice(0, 197).replace(/\s+\S*$/, '') + '…' : t;
}

/* ═══ Operations sheet ═══════════════════════════════════════════════════ */
const OPS_COLS = { sr: 1, dept: 2, agency: 3, desc: 4, custodian: 5, freq: 6, l1: 7, l2: 8,
  from: 9, to: 10, orig: 11, current: 12, status: 13, lead1: 14, lead2: 15, lead3: 16, remarks: 17 };

function findOpsHeader(ws) {
  for (let r = 1; r <= 10; r++) {
    const row = ws.getRow(r);
    if (/department/i.test(text(row.getCell(2).value)) && /agency/i.test(text(row.getCell(3).value))) return r;
  }
  return null;
}

function parseOperations(ws, ctx) {
  const header = findOpsHeader(ws);
  if (!header) return { error: 'header row (Department / Agency / Description) not found' };
  const out = [];
  let parent = null;
  const lastRow = ws.rowCount;
  for (let r = header + 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const c = k => row.getCell(OPS_COLS[k]).value;
    const raw = {};
    for (const [k, col] of Object.entries(OPS_COLS)) {
      let v = cellValue(row.getCell(col).value);
      if (typeof v === 'string') v = v.replace(/\u00a0/g, ' ').trim();
      if (v !== null && v !== '') raw[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    }
    const meaningful = Object.keys(raw).filter(k => k !== 'sr');
    if (!meaningful.length) { if (Object.keys(raw).length) ctx.classify('structural', 'Operations', r, 'serial number only'); continue; }

    let dept = text(c('dept')), agency = text(c('agency')), desc = text(c('desc'));
    const isChild = !dept && !agency && desc && parent;
    if (!dept && !isChild) { ctx.classify('skipped', 'Operations', r, 'no department'); continue; }

    const w = [];
    const rec = {
      source_sheet: 'Operations', source_row: r, source_raw: raw,
      section_label: isChild ? parent.section_label : dept,
      agency: isChild ? parent.agency : agency,
      description: desc || null,
      custodian: isChild ? parent.custodian : normCustodian(c('custodian')),
      frequency_label: isChild ? parent.frequency_label : (text(c('freq')) || null),
      entity: 'LCL', warnings: w, periods: [], assessments: [], valid_from: null, valid_to: null,
    };

    // Agency and description swapped (row 17: agency "FIRE SAFETY CERTIFICATE - HO").
    if (!isChild && /certificate|licen[cs]e/i.test(agency) && desc && desc.length < 25 && !/certificate|licen[cs]e/i.test(desc)
        && /rescue|authority|ministry|council|agency|board|force|commission|bureau/i.test(desc)) {
      rec.agency = desc; rec.description = agency;
      w.push('agency and description looked swapped — swapped back');
    }
    if (!isChild && /LCL\s*\/\s*UCL\s*\/\s*BRL/i.test(`${agency} ${desc}`)) {
      w.push('covers LCL / UCL / BRL — imported once under LCL; split per entity if tracked separately');
    }

    // People
    const l1 = isChild ? parent.l1 : splitPeople(c('l1')).map(canonicalPerson);
    const l2 = isChild ? parent.l2 : splitPeople(c('l2')).map(canonicalPerson);
    rec.l1 = l1; rec.l2 = l2;
    rec.responsibles = { 1: l1, 2: l2 };

    // Lead days (Direct / 2nd level / Head)
    let leads = isChild ? parent.leads : [parseLead(c('lead1')), parseLead(c('lead2')), parseLead(c('lead3'))];

    const statusText = text(c('status'));
    const remark = text(c('remarks'));
    let fromCell = c('from'), toCell = c('to');
    let statusForLifecycle = statusText;

    // Rows shifted one column right (171–172): From says "One Time", the
    // issue date sits under To, the status under the first reminder column.
    if (/one\s*time/i.test(text(fromCell)) && parseDate(toCell).date) {
      fromCell = toCell; toCell = 'One Time';
      statusForLifecycle = text(c('lead1')) || statusText;
      leads = [null, null, null];
      w.push('columns were shifted one place right — realigned (issue date read from the To column)');
    }
    const ld = leads.filter(x => x != null);
    if (ld.length && ld.some((x, i) => i && x > ld[i - 1])) { leads = [...ld].sort((a, b) => b - a); w.push('reminder days were not in descending order — sorted'); }
    rec.lead_days_1 = leads[0]; rec.lead_days_2 = leads[1]; rec.lead_days_3 = leads[2];

    const from = parseDate(fromCell), to = parseDate(toCell);
    if (from.warn) w.push(`Valid From: ${from.warn}`);
    if (to.warn) w.push(`Valid To: ${to.warn}`);
    // A cell already reported by parseDate (the 1905 year cells) is not
    // reported again as "not a date".
    const toText = (to.date || to.warn) ? '' : text(toCell);
    const fromText = (from.date || from.warn) ? '' : text(fromCell);
    const freq = (rec.frequency_label || '').toLowerCase();
    const sectionNorm = normSection(rec.section_label);

    // Lifecycle
    if (/inactive|not active/i.test(statusForLifecycle) || /not active/i.test(freq)) {
      rec.lifecycle = 'inactive'; rec.inactive_reason = 'Marked inactive in the workbook';
    } else if (/^na$/i.test(statusForLifecycle) && !to.date) {
      rec.lifecycle = 'inactive'; rec.inactive_reason = 'Marked N/A in the workbook';
      w.push('status "NA" with no dates — imported as Inactive');
    } else {
      rec.lifecycle = 'active';
    }
    if (/under renewal/i.test(statusForLifecycle) || RENEWAL_RE.test(remark)) {
      rec.renewal_in_progress = true;
      rec.renewal_note = [statusForLifecycle && /renew/i.test(statusForLifecycle) ? statusForLifecycle : null, RENEWAL_RE.test(remark) ? remark : null].filter(Boolean).join(' — ') || null;
    }
    rec.remarks = remark && !RENEWAL_RE.test(remark) ? remark : null;

    // Kind. A real date under To wins over the frequency label.
    const ruleM = toText.match(/(\d{1,2})(?:st|nd|rd|th)?\s+every\s+(month|quarter)/i);
    if (to.date) {
      rec.kind = 'validity'; rec.valid_to = to.date; rec.valid_from = from.date || null;
      if (/monthly/i.test(freq)) w.push('frequency says Monthly but a validity date is given — imported as a dated certificate/permit');
      if (rec.valid_from && rec.valid_from > rec.valid_to) { w.push('Valid From is after Valid To — From left blank'); rec.valid_from = null; }
    } else if (ruleM) {
      rec.kind = 'recurring';
      rec.rec_unit = ruleM[2].toLowerCase() === 'month' ? 'month' : 'quarter';
      rec.rec_due_day = +ruleM[1];
      if (rec.rec_unit === 'quarter') {
        if (/advance tax/i.test(`${rec.description} ${rec.agency}`)) { rec.rec_due_month = 3; w.push('advance tax read as due Mar/Jun/Sep/Dec — confirm with Finance'); }
        else { rec.rec_due_month = 1; w.push('quarterly — read as Jan/Apr/Jul/Oct; confirm the months'); }
      }
    } else if (/end of project|one\s*time/i.test(toText) || /one\s*time|once per project/i.test(freq) || /^fixed$/i.test(freq)) {
      rec.kind = 'validity'; rec.no_expiry = true; rec.valid_from = from.date || null;
      if (/^fixed$/i.test(freq)) w.push('frequency "FIXED" read as a registration with no expiry');
    } else if (/^yearly$/i.test(toText) || (!toText && /^yearly$/i.test(freq) && sectionNorm === 'accounts finance')) {
      rec.kind = 'recurring'; rec.rec_unit = 'year';
      w.push('yearly — the sheet gives no due date; set the due day and month');
    } else if (!toText && (/monthly/i.test(freq) || /\bmonthly\b/i.test(rec.description || ''))) {
      rec.kind = 'recurring'; rec.rec_unit = 'month'; w.push('monthly — no due day in the sheet; set it');
    } else if (!toText && (/quarterly/i.test(freq) || /\bquarterly\b/i.test(rec.description || ''))) {
      rec.kind = 'recurring'; rec.rec_unit = 'quarter'; rec.rec_due_month = 1; w.push('quarterly — no due day in the sheet; set it');
    } else if (!toText && /6\s*month/i.test(freq)) {
      rec.kind = 'recurring'; rec.rec_unit = 'half'; rec.rec_due_month = 1; w.push('six-monthly — no due day in the sheet; set it');
    } else {
      rec.kind = 'validity'; rec.valid_from = from.date || null;
      if (toText) w.push(`Valid To "${toText}" is not a date — left blank`);
      else if (rec.lifecycle === 'active') w.push('no expiry date in the sheet');
    }
    if (fromText && !/one\s*time/i.test(fromText) && rec.kind === 'validity' && !rec.valid_from) w.push(`Valid From "${fromText}" is not a date — left blank`);
    if (rec.kind === 'recurring') rec.track_from = ctx.today;

    rec.title = makeTitle(rec.description, rec.agency, rec.remarks);
    // HR's rows describe what each statutory fund does ("Provides benefits
    // to the workers…"); the fund is what people call the obligation.
    if (normSection(rec.section_label) === 'hr' && rec.agency && (rec.description || '').length > 40
        && !/submission|return|certificate|licen[cs]e|permit|report/i.test(rec.description)) rec.title = rec.agency;

    // Child rows of a bundle (row 125 "Integrated Management System
    // Certificates" → ISO 9001, ISO 14001/45001).
    if (isChild) {
      rec.group_key = parent.bundle_key;
      out.push(Object.assign(rec, { _class: 'child_item' }));
      ctx.classify('child_item', 'Operations', r);
      continue;
    }

    // A dated parent with following undated-department rows is detected
    // when the child arrives; an undated parent becomes the bundle itself.
    const next = ws.getRow(r + 1);
    const nextIsChild = !text(next.getCell(2).value) && !text(next.getCell(3).value) && text(next.getCell(4).value);
    if (nextIsChild && !to.date && !from.date) {
      const code = (rec.description || 'Bundle').replace(/certificates?/i, '').trim() || 'Bundle';
      const bundleKey = 'grp:bundle:' + sha1(`${sectionNorm}|${keyPart(code)}`).slice(0, 12);
      ctx.groups.push({ import_key: bundleKey, kind: 'bundle', code: code.slice(0, 60), title: rec.description, owner_role: null, section_label: rec.section_label, entity: 'LCL', attrs: { agency: rec.agency } });
      parent = Object.assign({}, rec, { bundle_key: bundleKey, leads });
      ctx.classify('group_header', 'Operations', r);
      continue;
    }
    parent = Object.assign({}, rec, { leads, bundle_key: null });
    out.push(Object.assign(rec, { _class: 'item' }));
    ctx.classify('item', 'Operations', r);
  }
  return { items: out };
}

/* ═══ Mining sheet ═══════════════════════════════════════════════════════ */
const MIN_COLS = { block: 2, desc: 3, freq: 4, status: 5, due: 6, l1: 7, l2: 8 };

/* Some Date cells in this sheet were typed dd/mm into an m/d locale, so day
   and month arrive swapped ("Monthly (before 4th)" holds 12 Apr 2025, which
   is 4 Dec 2025). Swap only when the frequency text itself confirms it. */
function unswapIfConfirmed(p, freqText, w) {
  if (!p || !p.date || !p.isCell) return p;
  const [y, m, d] = p.date.split('-').map(Number);
  if (d > 12) return p;
  const swapped = validYmd(y, d, m);
  if (!swapped) return p;
  const dayM = freqText.match(/(\d{1,2})(?:st|nd|rd|th)/);
  const monM = freqText.match(/before\s+([A-Za-z]{3,9})\b/i);
  const confirmsDay = dayM && +dayM[1] === m && +dayM[1] !== d;
  const confirmsMonth = monM && MON[monM[1].slice(0, 3).toLowerCase()] === d && d !== m;
  if (confirmsDay || confirmsMonth) {
    w.push(`date ${p.date} has day and month swapped in the sheet (the frequency says "${freqText}") — read as ${swapped}`);
    return Object.assign({}, p, { date: swapped });
  }
  return p;
}

function parseMining(ws, ctx) {
  const out = [];
  let block = null;
  const lastRow = ws.rowCount;
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const c = k => row.getCell(MIN_COLS[k]).value;
    const raw = {};
    for (const [k, col] of Object.entries(MIN_COLS)) {
      let v = cellValue(row.getCell(col).value);
      if (typeof v === 'string') v = v.replace(/\u00a0/g, ' ').trim();
      if (v !== null && v !== '') raw[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    }
    if (!Object.keys(raw).length) continue;
    const desc = text(c('desc'));
    const freqText = text(c('freq'));

    if (/^license no\.?$/i.test(desc)) {
      const code = text(c('freq'));
      block = { code, attrs: { resource: text(row.getCell(7).value) || null }, import_key: 'grp:mining:' + code };
      ctx.groups.push({ import_key: block.import_key, kind: 'mining_licence', code, title: code, owner_role: 'mining', section_label: 'Mining', entity: 'LCL', attrs: block.attrs });
      ctx.classify('group_header', 'Mining', r);
      continue;
    }
    if (!block) { ctx.classify('structural', 'Mining', r, 'title'); continue; }
    if (/^location$/i.test(desc)) {
      block.attrs.location = text(c('freq')) || null;
      const area = cellValue(row.getCell(7).value); if (area != null) block.attrs.area_km2 = +area || text(row.getCell(7).value);
      const g = ctx.groups.find(x => x.import_key === block.import_key);
      g.title = `${block.code} — ${block.attrs.location}`;
      ctx.classify('group_header', 'Mining', r); continue;
    }
    if (/^license type/i.test(desc)) { block.attrs.licence_type = text(c('freq')) || null; ctx.classify('group_header', 'Mining', r); continue; }
    if (!desc && /^frequency$/i.test(freqText)) { ctx.classify('structural', 'Mining', r, 'column headings'); continue; }
    if (!desc && !freqText && Object.keys(raw).length === 1 && raw.block !== undefined) {
      ctx.classify('structural', 'Mining', r, 'licence block number only'); continue;
    }
    if (/^note\b/i.test(desc) || (!freqText && !text(c('status')) && !text(c('due')) && !text(c('l1')))) {
      ctx.classify('structural', 'Mining', r, 'note'); continue;
    }

    const w = [];
    const rec = {
      source_sheet: 'Mining', source_row: r, source_raw: raw,
      section_label: 'Mining', agency: 'Mining Commission', description: desc,
      frequency_label: freqText || null, custodian: null, entity: 'LCL',
      group_key: block.import_key, _licence: block.code,
      warnings: w, periods: [], assessments: [], lifecycle: 'active', valid_from: null, valid_to: null,
    };
    const l1 = splitPeople(c('l1')).map(canonicalPerson), l2 = splitPeople(c('l2')).map(canonicalPerson);
    rec.responsibles = { 1: l1, 2: l2 };
    const statusText = text(c('status'));
    let due = parseDate(c('due'));
    due = unswapIfConfirmed(due, freqText, w);
    if (due.warn) w.push(`Due Next: ${due.warn}`);
    const fee = parseFee(desc);
    if (fee) { rec.fee_amount = fee.amount; rec.fee_currency = fee.currency; }
    const f = freqText.toLowerCase();
    const assess = assessmentFrom(statusText);
    if (/application (done|submitted)/i.test(statusText)) { rec.renewal_in_progress = true; rec.renewal_note = statusText; }

    if (/every\s*10\s*years|renewal\s*\d+\s*yrs|1st renewal/i.test(f) || /^mining lease|^prospective licen/i.test(desc)) {
      rec.kind = 'validity';
      const iss = desc.match(/date of issue\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      const from = iss ? parseDate(iss[1]) : { date: null };
      rec.valid_from = from.date || null;
      if (due.date) rec.valid_to = due.date; else w.push('no expiry date in the sheet');
      if (rec.valid_from && rec.valid_to && rec.valid_from > rec.valid_to) rec.valid_from = null;
      if (/modify|renew/i.test(statusText) && !/^active$/i.test(statusText)) rec.remarks = statusText;
    } else if (/should cover the lease/i.test(f)) {
      rec.kind = 'validity'; w.push('insurance "should cover the lease period" — set the policy expiry date');
      if (/punit|sankalp/i.test(`${l1} ${l2}`)) w.push('responsible people are in Finance — consider moving this to Finance');
    } else if (/as\s*&\s*when|as and when/i.test(f) || /as\s*&\s*when/i.test(statusText)) {
      rec.kind = 'recurring'; rec.rec_unit = 'on_demand';
    } else if (/continuous/i.test(f) || /review/i.test(f) || /one-time/i.test(f)) {
      rec.kind = 'condition';
      rec.review_interval_months = /every\s*3\s*yrs|3\s*years/i.test(f) ? 36 : /annual/i.test(f) ? 12 : (+ctx.settings.condition_review_months || 3);
      if (due.date && due.date > ctx.today) rec.next_review_on = due.date;
      else {
        rec.next_review_on = addDays(ctx.today, +ctx.settings.first_review_grace_days || 30);
        w.push(`no future review date in the sheet — first review set to ${rec.next_review_on}`);
      }
      if (assess) {
        rec.condition_result = assess.result; rec.condition_assessed_on = ctx.today;
        rec.assessments.push({ result: assess.result, raw_text: statusText, note: assess.note || null });
        if (assess.warn) w.push(assess.warn);
      }
    } else if (/every\s*3\s*yrs/i.test(f)) {
      rec.kind = 'recurring'; rec.rec_unit = 'years'; rec.rec_interval = 3;
      if (due.date) rec.rec_anchor_date = due.date; else w.push('every 3 years — no date in the sheet; set the next due date');
      if (assess) rec.remarks = statusText;
    } else if (/monthly/i.test(f)) {
      rec.kind = 'recurring'; rec.rec_unit = 'month';
      const dm = f.match(/(\d{1,2})(?:st|nd|rd|th)/); if (dm) rec.rec_due_day = +dm[1];
    } else if (/quarterly/i.test(f)) {
      rec.kind = 'recurring'; rec.rec_unit = 'quarter'; rec.rec_due_month = 1;
      const dm = f.match(/(\d{1,2})(?:st|nd|rd|th)/); if (dm) rec.rec_due_day = +dm[1];
    } else if (/annual/i.test(f)) {
      rec.kind = 'recurring'; rec.rec_unit = 'year';
      const dm = f.match(/(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]{3,9})/);
      const bm = f.match(/before\s+([A-Za-z]{3,9})\b/);
      if (dm && MON[dm[2].slice(0, 3)]) { rec.rec_due_day = +dm[1]; rec.rec_due_month = MON[dm[2].slice(0, 3)]; }
      else if (bm && MON[bm[1].slice(0, 3)]) {
        const mon = MON[bm[1].slice(0, 3)] - 1 || 12;   // "before July" → due by 30 June
        rec.rec_due_month = mon; rec.rec_due_day = new Date(Date.UTC(2001, mon, 0)).getUTCDate();
        w.push(`"${freqText}" read as due by ${rec.rec_due_day}/${mon}`);
      } else if (due.date) {
        rec.rec_due_month = +due.date.slice(5, 7); rec.rec_due_day = +due.date.slice(8, 10);
      } else {
        w.push('annual — no due date in the sheet; set it');
      }
    } else {
      rec.kind = 'validity'; w.push(`frequency "${freqText}" not recognised — imported as an undated obligation`);
    }

    if (rec.kind === 'recurring') {
      rec.track_from = ctx.today;
      if (rec.rec_unit !== 'on_demand' && due.date) {
        const st = assess ? assess.result : null;
        const pk = periodKey(rec, due.date);
        if (st === 'complied' && due.date <= ctx.today) rec.periods.push({ period_key: pk, due_on: due.date, status: 'done', note: `Workbook: ${statusText}` });
        else if (st === 'not_complied') rec.periods.push({ period_key: pk, due_on: due.date, status: 'open', note: `Workbook: ${statusText}` });
        else if (due.date < ctx.today) {
          rec.periods.push({ period_key: pk, due_on: due.date, status: 'open', note: statusText ? `Workbook: ${statusText}` : null });
          w.push(`the sheet does not say whether the ${due.date} instance was done — left open`);
        }
      }
      if (assess && assess.warn) w.push(assess.warn);
    } else if (rec.kind === 'validity' && assess && assess.result === 'not_complied') {
      w.push(`status "${statusText}" on a dated licence — check it`);
    }

    rec.title = makeTitle(desc, null, null);
    out.push(Object.assign(rec, { _class: 'item' }));
    ctx.classify('item', 'Mining', r);
  }
  return { items: out };
}

/* ═══ Certificate numbers from the old static MIS register ═════════════ */
const tokens = s => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length > 1));
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const t of a) if (b.has(t)) n++;
  return n / (a.size + b.size - n);
}
function enrichReferenceNumbers(items, certs) {
  if (!Array.isArray(certs) || !certs.length) return { matched: 0, unmatched: [] };
  const usable = certs.filter(c => c && c.no && String(c.no).trim());
  const used = new Set();
  let matched = 0;
  for (const it of items) {
    if (it.source_sheet !== 'Operations') continue;
    const itTok = tokens(`${it.description} ${it.remarks || ''}`);
    const agTok = tokens(it.agency);
    const scored = usable.map((c, i) => {
      const ag = jaccard(agTok, tokens(c.a));
      const desc = jaccard(itTok, tokens(`${c.d} ${c.r}`));
      const vt = c.vt && it.valid_to && c.vt.split('.').reverse().join('-') === it.valid_to;
      return { i, c, score: desc + (vt ? 0.3 : 0), ok: (ag >= 0.34 || desc >= 0.75) && (desc >= 0.6 || (vt && desc >= 0.3)) };
    }).filter(x => x.ok).sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    if (scored.length > 1 && scored[0].score - scored[1].score < 0.05) {
      it.warnings.push(`certificate number ambiguous: ${scored.length} candidates in the old register`);
      continue;
    }
    it.reference_no = String(scored[0].c.no).trim().slice(0, 100);
    used.add(scored[0].i); matched++;
  }
  const unmatched = usable.filter((c, i) => !used.has(i)).map(c => ({ description: c.d, agency: c.a, number: c.no, valid_to: c.vt || null, remark: c.r || null }));
  return { matched, unmatched };
}

/* ═══ Entry point ════════════════════════════════════════════════════════ */
async function parseComplianceWorkbook(buffer, opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const today = opts.today || todayIn();
  const settings = opts.settings || {};
  const classes = [];
  const ctx = {
    today, settings, groups: [],
    classify(cls, sheet, row, reason) { classes.push({ cls, sheet, row, reason: reason || null }); },
  };
  const visible = wb.worksheets.filter(ws => ws.state !== 'hidden' && ws.state !== 'veryHidden');
  const opsWs = visible.find(ws => /compliance\s*master\s*-\s*operations/i.test(ws.name));
  const minWs = visible.find(ws => /compliance\s*mat[st]*er\s*-\s*mining/i.test(ws.name));
  const missing = [];
  if (!opsWs) missing.push('Compliance Master - Operations');
  if (!minWs) missing.push('Compliance Master - Mining');
  if (!opsWs && !minWs) return { ok: false, error: 'Neither compliance sheet was found in this workbook — is this the Compliance Master?', missing };

  const items = [];
  const sheetErrors = [];
  if (opsWs) { const r = parseOperations(opsWs, ctx); if (r.error) sheetErrors.push(`Operations: ${r.error}`); else items.push(...r.items); }
  if (minWs) items.push(...parseMining(minWs, ctx).items);

  // Owner role from the section label (preview may override per section).
  const overrides = opts.sectionRoleOverrides || {};
  for (const it of items) {
    const ov = overrides[it.section_label];
    it.owner_role = (ov && OWNER_ROLES.includes(ov)) ? ov : roleForSection(it.section_label);
    if (!it.owner_role) it.warnings.push(`no department mapping for "${it.section_label}"`);
  }
  for (const g of ctx.groups) {
    if (!g.owner_role) {
      const child = items.find(i => i.group_key === g.import_key);
      g.owner_role = child ? child.owner_role : roleForSection(g.section_label);
    }
  }

  // Stable keys: duplicates (two identical "OVER HEAD CRANE :SWL-10 TON"
  // rows) get an ordinal in sheet order.
  const seen = new Map();
  for (const it of items) {
    const basis = it.source_sheet === 'Mining'
      ? `min|${it._licence}|${keyPart(it.description)}`
      : `ops|${keyPart(it.section_label)}|${keyPart(it.agency)}|${keyPart(it.description)}|${keyPart(it.remarks)}|${it.group_key || ''}`;
    const n = (seen.get(basis) || 0) + 1; seen.set(basis, n);
    it.import_key = (it.source_sheet === 'Mining' ? 'min:' : 'ops:') + sha1(basis).slice(0, 20) + (n > 1 ? `#${n}` : '');
  }

  const enrichment = enrichReferenceNumbers(items, opts.certs);

  // Reconciliation: every non-blank row classified exactly once.
  const bySheet = {};
  for (const c of classes) {
    bySheet[c.sheet] = bySheet[c.sheet] || { item: 0, child_item: 0, group_header: 0, structural: 0, skipped: 0 };
    bySheet[c.sheet][c.cls]++;
  }
  const nonBlank = {};
  for (const [name, ws] of [['Operations', opsWs], ['Mining', minWs]]) {
    if (!ws) continue;
    let n = 0;
    const hdr = name === 'Operations' ? (findOpsHeader(ws) || 0) + 2 : 1;
    for (let r = hdr; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      let any = false;
      const cols = name === 'Operations' ? Object.values(OPS_COLS) : Object.values(MIN_COLS);
      for (const col of cols) { const v = cellValue(row.getCell(col).value); if (v !== null && v !== '' && !(typeof v === 'string' && !v.replace(/\u00a0/g, ' ').trim())) { any = true; break; } }
      if (any) n++;
    }
    nonBlank[name] = n;
  }
  const reconciliation = Object.fromEntries(Object.entries(nonBlank).map(([sheet, n]) => {
    const b = bySheet[sheet] || {};
    const sum = Object.values(b).reduce((a, x) => a + x, 0);
    return [sheet, Object.assign({ nonBlankRows: n, classified: sum, balanced: sum === n }, b)];
  }));

  const ambiguous = {};
  for (const it of items) {
    const k = normSection(it.section_label);
    if (AMBIGUOUS_SECTIONS[k]) ambiguous[it.section_label] = { note: AMBIGUOUS_SECTIONS[k], role: it.owner_role, count: (ambiguous[it.section_label] || { count: 0 }).count + 1 };
  }
  const sections = {};
  for (const it of items) {
    sections[it.section_label] = sections[it.section_label] || { role: it.owner_role, count: 0 };
    sections[it.section_label].count++;
  }

  return {
    ok: true, today, missing, sheetErrors, items, groups: ctx.groups,
    classes: classes.filter(c => c.cls === 'skipped' || c.cls === 'structural'),
    reconciliation, sections, ambiguous, enrichment,
  };
}

/* ═══ Plan & commit ══════════════════════════════════════════════════════
   Re-import is idempotent and conservative: a new key is inserted; an
   existing row is updated only if nobody has verified or edited it in the
   app; anything else is KEPT and reported. Nothing is ever deleted — a row
   that has vanished from the workbook is reported, not removed. */
async function planImport(parsed, client) {
  const { rows } = await client.query(
    `SELECT id, import_key, verified_at, user_edited_at FROM compliance_items WHERE import_key IS NOT NULL`);
  const existing = new Map(rows.map(r => [r.import_key, r]));
  const fileKeys = new Set(parsed.items.map(i => i.import_key));
  const plan = parsed.items.map(it => {
    const ex = existing.get(it.import_key);
    if (!ex) return { key: it.import_key, action: 'new' };
    if (ex.verified_at || ex.user_edited_at) return { key: it.import_key, action: 'kept', id: ex.id, reason: ex.verified_at ? 'verified in the app' : 'edited in the app' };
    return { key: it.import_key, action: 'update', id: ex.id };
  });
  const missingFromFile = rows.filter(r => !fileKeys.has(r.import_key)).map(r => ({ id: r.id, key: r.import_key }));
  const counts = plan.reduce((a, p) => { a[p.action] = (a[p.action] || 0) + 1; return a; }, { new: 0, update: 0, kept: 0 });
  counts.missingFromFile = missingFromFile.length;
  return { plan, counts, missingFromFile };
}

const ITEM_COLS = ['kind', 'owner_role', 'section_label', 'entity', 'group_id', 'title', 'description', 'agency',
  'reference_no', 'custodian', 'frequency_label', 'valid_from', 'valid_to', 'no_expiry', 'rec_unit', 'rec_interval',
  'rec_due_day', 'rec_due_month', 'rec_anchor_date', 'track_from', 'review_interval_months', 'next_review_on',
  'condition_result', 'condition_assessed_on', 'lead_days_1', 'lead_days_2', 'lead_days_3', 'lifecycle',
  'inactive_reason', 'renewal_in_progress', 'renewal_note', 'renewal_started_on', 'fee_amount', 'fee_currency', 'remarks',
  'source_sheet', 'source_row', 'source_raw'];

function itemValues(it, groupId, today) {
  const v = {
    kind: it.kind, owner_role: it.owner_role, section_label: (it.section_label || '').slice(0, 60) || null,
    entity: it.entity || 'LCL', group_id: groupId || null, title: it.title, description: it.description || null,
    agency: it.agency ? it.agency.slice(0, 200) : null, reference_no: it.reference_no || null, custodian: it.custodian || null,
    frequency_label: it.frequency_label ? it.frequency_label.slice(0, 120) : null,
    valid_from: it.valid_from || null, valid_to: it.valid_to || null, no_expiry: !!it.no_expiry,
    rec_unit: it.rec_unit || null, rec_interval: it.rec_interval || 1, rec_due_day: it.rec_due_day || null,
    rec_due_month: it.rec_due_month || null, rec_anchor_date: it.rec_anchor_date || null, track_from: it.track_from || null,
    review_interval_months: it.review_interval_months || null, next_review_on: it.next_review_on || null,
    condition_result: it.condition_result || null, condition_assessed_on: it.condition_assessed_on || null,
    lead_days_1: it.lead_days_1 ?? null, lead_days_2: it.lead_days_2 ?? null, lead_days_3: it.lead_days_3 ?? null,
    lifecycle: it.lifecycle || 'active', inactive_reason: it.inactive_reason || null,
    renewal_in_progress: !!it.renewal_in_progress, renewal_note: it.renewal_note || null,
    renewal_started_on: it.renewal_in_progress ? today : null,
    fee_amount: it.fee_amount ?? null, fee_currency: it.fee_currency || null, remarks: it.remarks || null,
    source_sheet: it.source_sheet, source_row: it.source_row, source_raw: JSON.stringify(Object.assign({}, it.source_raw, { warnings: it.warnings })),
  };
  return ITEM_COLS.map(c => v[c]);
}

async function ensureContact(client, name, cache) {
  const k = name.toLowerCase();
  if (cache.has(k)) return cache.get(k);
  const ex = await client.query(`SELECT id FROM compliance_contacts WHERE LOWER(name) = $1 OR $1 = ANY (SELECT LOWER(a) FROM unnest(aliases) a) LIMIT 1`, [k]);
  let id;
  if (ex.rows.length) id = ex.rows[0].id;
  else {
    // Link to an MIS login when exactly one active user has this full name.
    const u = await client.query(`SELECT id FROM users WHERE active AND LOWER(full_name) = $1`, [k]);
    const userId = u.rows.length === 1 ? u.rows[0].id : null;
    const ins = await client.query(
      `INSERT INTO compliance_contacts (name, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING id`, [name, userId]);
    id = ins.rows.length ? ins.rows[0].id
      : (await client.query(`SELECT id FROM compliance_contacts WHERE LOWER(name) = $1`, [k])).rows[0].id;
  }
  cache.set(k, id);
  return id;
}

async function commitImport(parsed, client, actor, meta) {
  const today = parsed.today;
  const { plan, counts, missingFromFile } = await planImport(parsed, client);
  const byKey = new Map(plan.map(p => [p.key, p]));

  // Groups first.
  const groupIds = new Map();
  for (const g of parsed.groups) {
    const r = await client.query(
      `INSERT INTO compliance_groups (kind, code, title, owner_role, entity, attrs, import_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (import_key) DO UPDATE SET title = EXCLUDED.title, attrs = EXCLUDED.attrs, owner_role = EXCLUDED.owner_role
       RETURNING id`,
      [g.kind, g.code, g.title, g.owner_role || 'hr', g.entity, JSON.stringify(g.attrs || {}), g.import_key]);
    groupIds.set(g.import_key, r.rows[0].id);
  }

  const contactCache = new Map();
  const touched = [];
  for (const it of parsed.items) {
    const p = byKey.get(it.import_key);
    if (!it.owner_role) continue;
    if (p.action === 'kept') continue;
    const vals = itemValues(it, groupIds.get(it.group_key), today);
    let id;
    if (p.action === 'new') {
      const cols = [...ITEM_COLS, 'source', 'import_key', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name'];
      const all = [...vals, 'import', it.import_key, actor.id, actor.name, actor.id, actor.name];
      const r = await client.query(
        `INSERT INTO compliance_items (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, all);
      id = r.rows[0].id;
      await client.query(`INSERT INTO compliance_history (item_id, actor_id, actor_name, action, note) VALUES ($1,$2,$3,'imported',$4)`,
        [id, actor.id, actor.name, `${meta.fileName} — ${it.source_sheet} row ${it.source_row}`]);
    } else {
      id = p.id;
      const sets = ITEM_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await client.query(`UPDATE compliance_items SET ${sets}, updated_at = NOW(), updated_by = $${ITEM_COLS.length + 2}, updated_by_name = $${ITEM_COLS.length + 3} WHERE id = $1`,
        [id, ...vals, actor.id, actor.name]);
      await client.query(`DELETE FROM compliance_item_responsibles WHERE item_id = $1`, [id]);
      await client.query(`INSERT INTO compliance_history (item_id, actor_id, actor_name, action, note) VALUES ($1,$2,$3,'reimported',$4)`,
        [id, actor.id, actor.name, `${meta.fileName} — ${it.source_sheet} row ${it.source_row}`]);
    }
    for (const tier of [1, 2]) {
      const names = (it.responsibles && it.responsibles[tier]) || [];
      for (let i = 0; i < names.length; i++) {
        const cid = await ensureContact(client, names[i], contactCache);
        await client.query(`INSERT INTO compliance_item_responsibles (item_id, tier, contact_id, position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [id, tier, cid, i]);
      }
    }
    for (const per of it.periods || []) {
      await client.query(
        `INSERT INTO compliance_periods (item_id, period_key, due_on, status, done_on, note, source)
         VALUES ($1,$2,$3,$4,$5,$6,'import')
         ON CONFLICT (item_id, period_key) DO UPDATE SET status = EXCLUDED.status, done_on = EXCLUDED.done_on, note = EXCLUDED.note
           WHERE compliance_periods.source = 'import'`,
        [id, per.period_key, per.due_on, per.status, per.status === 'done' ? per.due_on : null, per.note || null]);
    }
    if (p.action === 'new') {
      for (const a of it.assessments || []) {
        await client.query(
          `INSERT INTO compliance_assessments (item_id, assessed_on, result, note, raw_text, source) VALUES ($1,NULL,$2,$3,$4,'import')`,
          [id, a.result, a.note, (a.raw_text || '').slice(0, 200)]);
      }
    }
    touched.push(id);
  }

  // Aliases recorded on the contacts the workbook spells two ways.
  for (const [alias, canonical] of Object.entries(PERSON_ALIASES)) {
    if (alias === canonical.toLowerCase()) continue;
    await client.query(
      `UPDATE compliance_contacts SET aliases = array_append(aliases, $1)
        WHERE LOWER(name) = LOWER($2) AND NOT ($1 = ANY (aliases))`, [alias, canonical]);
  }

  const warnings = parsed.items.filter(i => i.warnings.length).map(i => ({ key: i.import_key, sheet: i.source_sheet, row: i.source_row, title: i.title, warnings: i.warnings }));
  const imp = await client.query(
    `INSERT INTO compliance_imports (by_id, by_name, file_name, file_sha256, counts, mapping, warnings)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, at`,
    [actor.id, actor.name, meta.fileName, meta.sha256, JSON.stringify(Object.assign({}, counts, { reconciliation: parsed.reconciliation })),
      JSON.stringify(parsed.sections), JSON.stringify(warnings.slice(0, 500))]);
  return { importId: imp.rows[0].id, counts, missingFromFile, touched };
}

module.exports = { parseComplianceWorkbook, planImport, commitImport, _test: { parseDate, makeTitle, assessmentFrom, splitPeople, canonicalPerson, parseFee, unswapIfConfirmed } };
