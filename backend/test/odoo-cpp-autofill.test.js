/*
  test/odoo-cpp-autofill.test.js — the pure half of the CPP autofill
  (services/odooCppAutofill.js + config/odooCppMap.js). No database, no Odoo.

  The properties that make it safe to run unattended against a live ERP:
    1. Only state='complete' entries fill a day, and a date with two complete
       entries is withheld rather than guessed.
    2. Never a fabricated zero: a lab reading Odoo leaves at 0 ("not
       measured") is omitted, and an all-zero entry fills nothing.
    3. A day a person touched is theirs — any person-column set marks it.
    4. Every mapped field is a real input on the CPP page, so the autofill
       cannot write a key nobody reads.

  Usage: node --test test/odoo-cpp-autofill.test.js   (from backend/)
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { mapEntry, pickCompleteEntries, isHumanRow, reconcileDay } = require('../services/odooCppAutofill');
const { CPP_FIELD_MAP, CPP_MANUAL_FIELDS } = require('../config/odooCppMap');

/* CPP/2026/00189 (2026-10-10), as Odoo's cpp_entry holds it. */
const ENTRY_1010 = {
  id: 1314, name: 'CPP/2026/00189', d: '2026-10-10', state: 'complete', approval_status: 'approved',
  gross_power: 171300, auxiliary_power: 18400, running_hrs: 24, feed_water: 775, boiler_steam: 765,
  bleed_steam: 59, turbine_steam: 703, condensate_gen: 573, auxiliary_steam: 18, coal_consumption: 138,
  steam_enthalpy: 803, feed_water_enthalpy: 130, dm_water_enthalpy: 30, boiler_efficiency: 0.78,
  heat_rate_tg: 2764.3841214244017, heat_rate_plant: 3853.2264583052674, dg_power: 0, coal_gcv_adb: 4771,
  dm_water_gen: 15, dm_water_cons: 14, ct_makeup_cons: 18, fly_ash_gcv: 26, gcv: 2123,
  fly_ash_cement: 32, fly_ash_coalyard: 1, fly_ash_dumpyard: 0,
};

test('mapEntry: maps a real entry, rounding Odoo\'s float noise', () => {
  const f = mapEntry(ENTRY_1010);
  assert.equal(f.cpp_gross_gen_kwh, 171300);
  assert.equal(f.cpp_coal_cons, 138);
  assert.equal(f.cpp_heat_rate_tg, 2764.38);
  assert.equal(f.cpp_heat_rate_plant, 3853.23);
  assert.equal(f.cpp_boiler_efficiency, 0.78);
  assert.equal(Object.keys(f).length, CPP_FIELD_MAP.length);
});

test('mapEntry: Odoo\'s swapped fly-ash columns land by meaning, not by name', () => {
  const f = mapEntry(ENTRY_1010);
  assert.equal(f.cpp_flyash_combustible_pct, 26, 'combustible % comes from Odoo fly_ash_gcv');
  assert.equal(f.cpp_flyash_gcv, 2123, 'fly-ash GCV comes from Odoo gcv');
});

test('mapEntry: a quantity of 0 is the plant\'s statement and is written', () => {
  const f = mapEntry(ENTRY_1010);
  assert.equal(f.cpp_dg_gen_kwh, 0);
  assert.equal(f.cpp_flyash_to_dumpyard_nos, 0);
});

test('mapEntry: a lab reading of 0 means "not measured" and is never written', () => {
  /* 2025-06-07 shape: the plant ran, the lab readings were left at 0. */
  const f = mapEntry({ ...ENTRY_1010, coal_gcv_adb: 0, gcv: 0, fly_ash_gcv: 0, boiler_efficiency: 0 });
  for (const k of ['cpp_coal_gcv', 'cpp_flyash_gcv', 'cpp_flyash_combustible_pct', 'cpp_boiler_efficiency']) {
    assert.equal(k in f, false, `${k} must be omitted, not written as 0`);
  }
  assert.equal(f.cpp_gross_gen_kwh, 171300, 'the rest of the day still fills');
});

test('mapEntry: a non-finite heat rate (a zero-generation day) is omitted', () => {
  const f = mapEntry({ ...ENTRY_1010, heat_rate_tg: Infinity, heat_rate_plant: NaN });
  assert.equal('cpp_heat_rate_tg' in f, false);
  assert.equal('cpp_heat_rate_plant' in f, false);
});

test('mapEntry: an all-zero entry (Odoo\'s blank "New #" shape) fills nothing', () => {
  const blank = Object.fromEntries(Object.keys(ENTRY_1010).map(k => [k, typeof ENTRY_1010[k] === 'number' ? 0 : ENTRY_1010[k]]));
  assert.deepEqual(mapEntry(blank), {});
  assert.deepEqual(mapEntry(null), {});
});

test('pickCompleteEntries: drafts and cancelled entries never fill a day', () => {
  const { byDate, ambiguous } = pickCompleteEntries([
    { id: 1, d: '2026-09-28', state: 'draft' },
    { id: 2, d: '2026-09-28', state: 'complete' },
    { id: 3, d: '2026-10-01', state: 'cancel' },
    { id: 4, d: '2026-10-01', state: 'complete' },
    { id: 5, d: '2026-10-15', state: 'draft' },
  ]);
  assert.deepEqual(Object.keys(byDate).sort(), ['2026-09-28', '2026-10-01']);
  assert.equal(byDate['2026-09-28'].id, 2);
  assert.equal(byDate['2026-10-01'].id, 4);
  assert.deepEqual(ambiguous, []);
});

test('pickCompleteEntries: two complete entries on one date are withheld, not guessed', () => {
  const { byDate, ambiguous } = pickCompleteEntries([
    { id: 1, d: '2023-01-15', state: 'complete' },
    { id: 2, d: '2023-01-15', state: 'complete' },
  ]);
  assert.deepEqual(byDate, {});
  assert.deepEqual(ambiguous, ['2023-01-15']);
});

test('isHumanRow: any person-column hands the day to people', () => {
  assert.equal(isHumanRow(null), false);
  assert.equal(isHumanRow({ submitted_by: null, updated_by: null, approved_by: null, rejected_by: null }), false);
  for (const col of ['submitted_by', 'updated_by', 'approved_by', 'rejected_by']) {
    assert.equal(isHumanRow({ [col]: 8 }), true, `${col} set must count as a person's day`);
  }
});

test('reconcileDay: writes only what differs, and names what it replaces', () => {
  const { toWrite, differences } = reconcileDay(
    { cpp_gross_gen_kwh: 171300, cpp_coal_cons: 130, cpp_heat_rate_tg: 2764.38 },
    { cpp_gross_gen_kwh: 171300, cpp_coal_cons: 138, cpp_heat_rate_tg: 2764.384, cpp_aux_kwh: 18400 });
  assert.deepEqual(toWrite, { cpp_coal_cons: 138, cpp_aux_kwh: 18400 });
  assert.deepEqual(differences, [{ field: 'cpp_coal_cons', stored_value: 130, odoo_value: 138 }]);
  assert.deepEqual(reconcileDay(null, { cpp_aux_kwh: 1 }).toWrite, { cpp_aux_kwh: 1 });
});

test('every mapped field is a real input on the CPP page, and none is also listed as manual', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'power-plant-report.html'), 'utf8');
  for (const m of CPP_FIELD_MAP) {
    assert.ok(html.includes(`data-field="${m.field}"`), `${m.field} has no input on power-plant-report.html`);
    assert.ok(['qty', 'lab'].includes(m.kind), `${m.field} kind must be qty or lab`);
    assert.ok(m.jul_sep, `${m.field} must record its measured match count`);
    assert.equal(m.field in CPP_MANUAL_FIELDS, false, `${m.field} is both mapped and manual`);
  }
  const fields = CPP_FIELD_MAP.map(m => m.field);
  assert.equal(new Set(fields).size, fields.length, 'a field is mapped twice');
});
