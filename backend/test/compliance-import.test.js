/*
  test/compliance-import.test.js — reading the Compliance Master workbook
  (services/complianceImport.js).

  Runs against the synthetic workbook in test/fixtures (always — CI never
  sees the real file, which must stay out of the repository), and also
  against the real "1. Compliance Master.xlsx" when it is present at the
  repo root or named by COMPLIANCE_WORKBOOK, pinning the figures the import
  was reviewed against on 2026-10-12.

  Pure: no server, no Postgres. Usage: node --test test/compliance-import.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseComplianceWorkbook, _test: T } = require('../services/complianceImport');
const S = require('../services/complianceStatus');
const { buildWorkbook, EXPECTED, TODAY } = require('./fixtures/compliance-workbook');

const statusOf = (it) => {
  const open = (it.periods || []).filter(p => p.status === 'open');
  const sim = it.kind === 'recurring' ? S.periodsToCreate(it, TODAY, new Set((it.periods || []).map(p => p.period_key)), {}) : [];
  return S.computeStatus(Object.assign({}, it, { verified_at: 'x' }), { today: TODAY, settings: {}, openPeriods: open.concat(sim), hasDirect: true });
};

let parsed;
test.before(async () => { parsed = await parseComplianceWorkbook(await buildWorkbook(), { today: TODAY }); });
const find = (sheet, titleRe) => parsed.items.find(i => i.source_sheet === sheet && titleRe.test(i.title));

test('only the two visible sheets are read; every non-blank row is accounted for', () => {
  assert.equal(parsed.ok, true);
  assert.equal(parsed.items.filter(i => i.source_sheet === 'Operations').length, EXPECTED.operationsItems);
  assert.equal(parsed.items.filter(i => i.source_sheet === 'Mining').length, EXPECTED.miningItems);
  assert.equal(parsed.groups.length, EXPECTED.groups);
  assert.equal(parsed.reconciliation.Operations.nonBlankRows, EXPECTED.operationsNonBlank);
  assert.equal(parsed.reconciliation.Mining.nonBlankRows, EXPECTED.miningNonBlank);
  assert.ok(parsed.reconciliation.Operations.balanced && parsed.reconciliation.Mining.balanced);
  assert.ok(!parsed.items.some(i => /should never be read/.test(i.title)), 'the hidden draft sheet is ignored');
});

test('status comes from the dates, not the sheet: an "Active" row past its date is Overdue', () => {
  const osha = find('Operations', /OSHA - Compliance License -HO/);
  assert.equal(osha.source_raw.status, 'Active');
  assert.equal(statusOf(osha).status, 'overdue');
});

test('the 1905 cells are years typed into a date cell — left blank, with a warning, never guessed', () => {
  const ew = find('Operations', /Lubricants/);
  assert.equal(ew.valid_from, null);
  assert.equal(ew.valid_to, null);
  assert.ok(ew.warnings.some(w => /year 2019/.test(w)) && ew.warnings.some(w => /year 2024/.test(w)));
  assert.equal(statusOf(ew).status, 'undated');
});

test('a row shifted one column right is realigned', () => {
  const tin = find('Operations', /TIN CERTIFICATE/);
  assert.equal(tin.no_expiry, true);
  assert.equal(tin.valid_from, '2006-06-09');
  assert.ok(tin.warnings.some(w => /shifted/.test(w)));
});

test('agency and description swapped back; End of Project is no expiry; Inactive stays inactive', () => {
  const fire = find('Operations', /FIRE SAFETY CERTIFICATE/);
  assert.equal(fire.agency.trim(), 'Fire & Rescue');
  assert.equal(find('Operations', /Environmental Impact/).no_expiry, true);
  const permit = find('Operations', /Building Permit/);
  assert.equal(permit.lifecycle, 'inactive');
  assert.match(permit.title, /\(Boundary Wall\)/);
});

test('recurring rules in the To column', () => {
  const vat = find('Operations', /VAT PAYMENT/);
  assert.deepEqual([vat.kind, vat.rec_unit, vat.rec_due_day], ['recurring', 'month', 20]);
  const csl = find('Operations', /City Service Levy/);
  assert.deepEqual([csl.rec_unit, csl.rec_due_day, csl.rec_due_month], ['quarter', 7, 1]);
  const adv = find('Operations', /Advance Tax/);
  assert.equal(adv.rec_due_month, 3, 'advance tax falls due Mar/Jun/Sep/Dec');
  const rent = find('Operations', /Annual Rent/);
  assert.equal(rent.rec_unit, 'year');
  assert.equal(statusOf(rent).status, 'undated', '"Yearly" alone is not a due date');
});

test('a bundle parent becomes a group; its children inherit section, agency, people and lead days', () => {
  const iso = find('Operations', /ISO 9001/);
  assert.equal(iso.section_label, 'Training');
  assert.equal(iso.agency, 'ACM');
  assert.deepEqual(iso.responsibles[1], ['Silvia']);
  assert.equal(iso.lead_days_1, 45);
  assert.ok(iso.group_key && iso.group_key.startsWith('grp:bundle:'));
});

test('ownership follows the agreed map (admin-type sections → HR & Admin)', () => {
  const role = re => find('Operations', re).owner_role;
  assert.equal(role(/Business License - HO/), 'hr');       // Corporate - Admin
  assert.equal(role(/Environmental Impact/), 'hr');        // Admin/Safety
  assert.equal(role(/ISO 9001/), 'hr');                    // Training
  assert.equal(role(/OVER HEAD CRANE/), 'pm');
  assert.equal(role(/VAT PAYMENT/), 'finance');
  assert.ok(parsed.items.filter(i => i.source_sheet === 'Mining').every(i => i.owner_role === 'mining'));
});

test('people: "Muneesh/ Rahul" is two contacts; spellings of one person are merged', () => {
  assert.deepEqual(find('Operations', /City Service Levy/).responsibles[1], ['Muneesh Kumar', 'Rahul']);
  assert.deepEqual(find('Mining', /ML|Mining Lease \(Date of Issue - 24/).responsibles[1], ['Sajivkumar PS']);
});

test('duplicate rows get distinct, stable keys', () => {
  const cranes = parsed.items.filter(i => /OVER HEAD CRANE/.test(i.title));
  assert.equal(cranes.length, 2);
  assert.notEqual(cranes[0].import_key, cranes[1].import_key);
  assert.match(cranes[1].import_key, /#2$/);
  assert.equal(new Set(parsed.items.map(i => i.import_key)).size, parsed.items.length);
});

test('mining: day/month swaps fixed only where the frequency text confirms them', () => {
  const monthly = find('Mining', /Monthly mining royalty/);
  assert.deepEqual(monthly.periods.map(p => [p.due_on, p.status]), [['2025-12-04', 'done']]);
  const csr = find('Mining', /CSR Plan/);
  assert.equal(csr.periods[0].due_on, '2026-07-01');
  assert.equal(csr.rec_due_month, 6, '"before July" = due by 30 June');
  const lease = find('Mining', /Date of Issue - 24\/05\/10/);
  assert.deepEqual([lease.valid_from, lease.valid_to], ['2010-05-24', '2030-05-23']);
});

test('mining: "Not complied" opens a real overdue period / assessment; fees are parsed', () => {
  assert.equal(statusOf(find('Mining', /Mining Plan Compliance Report/)).status, 'overdue');
  const dist = find('Mining', /200 meters/);
  assert.equal(dist.kind, 'condition');
  assert.equal(statusOf(dist).status, 'overdue');
  assert.equal(statusOf(find('Mining', /compensation plan/)).status, 'due', 'partially complied is at least Due');
  const rent = find('Mining', /Rent @/);
  assert.deepEqual([rent.fee_amount, rent.fee_currency], [12320, 'USD']);
  assert.equal(find('Mining', /Ushuru/).rec_unit, 'on_demand');
});

test('parsing helpers', () => {
  assert.equal(T.parseDate('02.12.2025').date, '2025-12-02');
  assert.equal(T.parseDate('1st Jan 23').date, '2023-01-01');
  assert.equal(T.parseDate('31.02.2025').date, null);
  assert.deepEqual(T.splitPeople('Muneesh/ Rahul'), ['Muneesh', 'Rahul']);
  assert.equal(T.canonicalPerson('PSS Sajiv'), 'Sajivkumar PS');
  assert.deepEqual(T.parseFee('Rent @ US$ 10,120 or Tsh 25,603,600'), { amount: 10120, currency: 'USD' });
  assert.equal(T.assessmentFrom('Not complied').result, 'not_complied');
  assert.equal(T.assessmentFrom('Complied').result, 'complied');
});

/* ── The real workbook, when it is available ─────────────────────────── */
const REAL = process.env.COMPLIANCE_WORKBOOK || path.join(__dirname, '..', '..', '1. Compliance Master.xlsx');
test('the real Compliance Master workbook (2026-10-12 review figures)', { skip: !fs.existsSync(REAL) && 'real workbook not present' }, async () => {
  const p = await parseComplianceWorkbook(fs.readFileSync(REAL), { today: TODAY });
  assert.ok(p.reconciliation.Operations.balanced && p.reconciliation.Mining.balanced, JSON.stringify(p.reconciliation));
  assert.equal(p.items.filter(i => i.source_sheet === 'Operations').length, 155);
  assert.equal(p.items.filter(i => i.source_sheet === 'Mining').length, 48);
  const dated = p.items.filter(i => i.kind === 'validity' && i.valid_to && i.lifecycle === 'active' && i.source_sheet === 'Operations');
  assert.equal(dated.filter(i => i.valid_to < TODAY).length >= 90, true, 'the stale-date problem the module exists for is visible');
  assert.equal(new Set(p.items.map(i => i.import_key)).size, p.items.length);
  const ew = p.items.find(i => /Lubricants/.test(i.title));
  assert.equal(ew.valid_to, null);
});
