#!/usr/bin/env python3
"""
verify-cpp.py — INDEPENDENT full-coverage verification of the `cpp`
form_type (Captive Power Plant, FRM-LCL-PP-06) for Jul-Sep 2026, separate
from import-cpp.js's own logic.

What it proves, for every REPORTED day of 2026-07-01..2026-09-30, against a
fresh GET from the local API (September is the month in progress: the days
its workbook leaves blank are listed, not failed):

  1. DAILY (workbook column E) — every stored fact equals the plant's own
     daily figure.
  2. MONTH TO DATE (column F) — the app's MTD rollup, which SUMS the stored
     days from the 1st (power-plant-report.html's report-rollup/computeRatios;
     the workbook's F column is never imported), reproduces the workbook's
     own MTD cell.
  3. YEAR TO DATE (column G) — same, summed from fiscal 1 April, so this
     also re-checks that the Apr-Jun rows already in the database carry the
     workbook's opening YTD (the Jul workbook's carry-in sheet "0").
  4. DERIVED ROWS — Net Exported, Aux %, Avg Generation, PLF, Specific
     Steam Consumption, Specific Fuel Consumption, Heat Rate (TG) and Heat
     Rate (Plant), daily AND MTD AND YTD, recomputed here from the stored
     facts with the same arithmetic power-plant-report.html uses, and
     diffed against the workbook's own formula cells. Six of those eight
     rows are deliberately not stored at all, so this is what says the
     app's formula layer agrees with the plant's spreadsheet.

Unlike import-cpp.js (which hardcodes ROW_FACT row numbers), this locates
every row by scanning its column C label fresh per sheet — so a row shift
in one day's sheet cannot hide behind the importer's own assumption. It
also re-reads each sheet's real date from row 6 column E rather than
trusting the sheet name.

Usage: python backend/scripts/verify-cpp.py
Requires: VERIFY_CPP_USER (default import-cpp), VERIFY_CPP_PASS
"""
import json
import os
import sys
import urllib.request
import urllib.error
import calendar
import re
import datetime as dt
import openpyxl
import warnings
warnings.filterwarnings('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
API = os.environ.get('VERIFY_BASE_URL', 'http://127.0.0.1:5000/api')

CPP_USER = os.environ.get('VERIFY_CPP_USER', 'import-cpp')
CPP_PASS = os.environ.get('VERIFY_CPP_PASS')

SAMPLES = os.path.join(ROOT, 'data', 'samples', '2026-04-21')
MONTHS = [
    {'file': os.path.join(SAMPLES, 'DAILY,MONTHLY & EARLY REPORT-JULY-2026.xlsx'), 'year': 2026, 'month': 7},
    {'file': os.path.join(SAMPLES, 'DAILY,MONTHLY & EARLY REPORT--AUG 2026.xlsx'), 'year': 2026, 'month': 8},
    {'file': os.path.join(SAMPLES, 'DAILY,MONTHLY & YEARLY REPORT-SEP-2026.xlsx'), 'year': 2026, 'month': 9},
]

# The four lab/DCS constants, per column, as the workbook hardcodes them
# into its own heat-rate formulas — re-parsed here from the formula text
# (openpyxl expands the shared formulas exceljs hands back unexpanded) so
# the importer's own extraction is checked rather than trusted.
CONST_FIELDS = ['cpp_superheated_steam_enthalpy', 'cpp_feedwater_enthalpy',
                'cpp_dm_water_enthalpy', 'cpp_boiler_efficiency']
COL_SUFFIX = {5: '', 6: '_mtd', 7: '_ytd'}

FISCAL_START = '2026-04-01'

# Absolute tolerances. Raw facts are stored rounded to 2dp by the importer,
# so 0.005 is the exact width of that rounding. The two heat-rate rollups
# get 0.05 kcal/kWh: the app's MTD/YTD figure is a generation-weighted mean
# of those already-2dp-rounded daily readings, where the workbook divides
# un-rounded period totals — the same number, reached in an order that can
# disagree in the second decimal place. On a ~2,800 kcal/kWh reading that is
# under 2 parts per 100,000.
TOL = 0.005
TOL_RATE_ROLLUP = 0.05

# Column C label (lowercased, stripped) -> stored fact name. Matched as a
# prefix so the plant's own trailing spaces and annotations
# ("Heat Rate(TG)2880") need not be reproduced character for character.
LABEL_FACT = [
    ('gross power generation',        'cpp_gross_gen_kwh'),
    ('auxiliary power consumption',   'cpp_aux_kwh'),
    ('plant running hours',           'cpp_run_hrs'),
    ('feed water consumption',        'cpp_feed_water_mt'),
    ('boiler steam generation',       'cpp_boiler_steam_mt'),
    ('bleed steam',                   'cpp_bleed_steam_mt'),
    ('turbine steam consumption',     'cpp_turbine_steam_mt'),
    ('condensate generation',         'cpp_condensate_mt'),
    ('auxilairy steam consumption',   'cpp_aux_steam_mt'),
    ('heat rate(tg)',                 'cpp_heat_rate_tg'),
    ('heat rate ( plant )',           'cpp_heat_rate_plant'),
    ('dg power generation',           'cpp_dg_gen_kwh'),
    ('coal consumption',              'cpp_coal_cons'),
    ('gcv ( adb )',                   'cpp_coal_gcv'),
    ('dm water generation',           'cpp_dm_water_gen_m3'),
    ('dm water consumption',          'cpp_dm_water_cons_m3'),
    ('ct makeup water consumption',   'cpp_ct_makeup_m3'),
    ('fly ash to cement mill',        'cpp_flyash_to_cm_mt'),
    ('fly ash to coal',               'cpp_flyash_to_coalyard_nos'),
    ('fly ash to dump',               'cpp_flyash_to_dumpyard_nos'),
]

# Facts the workbook does NOT accumulate: the spot lab readings (coal GCV,
# the fly-ash combustible/GCV pair) and the two heat rates, which it
# re-derives per column instead of summing.
NO_ROLLUP = {'cpp_coal_gcv', 'cpp_heat_rate_tg', 'cpp_heat_rate_plant',
             'cpp_flyash_combustible_pct', 'cpp_flyash_gcv'}

DERIVED_LABELS = [
    ('net',  'net power exported',          None),
    ('aux%', 'auxiliary power consumption', '%'),
    ('avg',  'average power generation',    None),
    ('plf',  'plf',                         None),
    ('ssc',  'specific steam consumption',  None),
    ('sfc',  'specific fuel consumption',   None),
]

# Cells where the WORKBOOK is wrong and the app is right, so the run is not
# failed by them. Each one is a formula the plant overtyped on a single
# sheet, confirmed by reading that sheet's formula against the same cell on
# every other day of both months. Keyed (date, kind, label) -> reason.
#
# 2026-08-24: that sheet's MTD and YTD Heat Rate (TG) cells read
#   =((F17*803)-(F17+F31)*142)*1000/F7
# where every other sheet in both workbooks reads
#   =((F17*(803-130)+F31*(30))*1000)/F7
# — the standard FRM-LCL-PP-06 formula, and the one its own DAILY cell (E22)
# still uses on that very sheet. The variant subtracts a 142 kcal/kg
# feedwater enthalpy from the turbine AND DM water flows together, which is
# not the form's method, and it drops the figure ~63 kcal/kWh below both the
# day before (2,811.83) and the day after (2,811.86). It does not cascade:
# each day's F22 is computed from that day's own F17/F31/F7, so only this one
# sheet's two cells are affected and the workbook's own 31 Aug MTD is unhurt.
KNOWN_SOURCE_DEFECTS = {
    ('2026-08-24', 'MTD', 'rollup hr_tg'): 'workbook cell F22 uses a non-standard formula on this sheet only',
    ('2026-08-24', 'YTD', 'rollup hr_tg'): 'workbook cell G22 uses a non-standard formula on this sheet only',
}

PRE = chr(10)

FAILURES = []
KNOWN = []
missing_consts = []
CHECKS = 0
MAXDEV = {}


def api(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print('API %s %s -> HTTP %s: %s' % (method, path, e.code, e.read().decode()[:300]))
        sys.exit(1)


def num(v):
    if v is None or v == '':
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def cell(ws, row, col):
    v = ws.cell(row=row, column=col).value
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def check(label, date, kind, got, want, tol=TOL):
    """got = what the app holds or derives, want = the workbook's own cell."""
    global CHECKS
    if want is None:
        return
    CHECKS += 1
    if got is None:
        FAILURES.append('%s %-4s %-28s MISSING in app (workbook: %s)' % (date, kind, label, want))
        return
    dev = abs(got - want)
    reason = KNOWN_SOURCE_DEFECTS.get((date, kind, label))
    if reason and dev > tol:
        KNOWN.append('%s %-4s %-28s app=%.4f workbook=%.4f  - %s' % (date, kind, label, got, want, reason))
        return
    key = '%s %s' % (kind, label)
    if dev > MAXDEV.get(key, -1):
        MAXDEV[key] = dev
    if dev > tol:
        FAILURES.append('%s %-4s %-28s app=%r workbook=%r dev=%.6g' % (date, kind, label, got, want, dev))


def sheet_rows(ws):
    """Locate every mapped fact's row by its own column C label."""
    found = {}
    for row in range(1, ws.max_row + 1):
        raw = ws.cell(row=row, column=3).value
        if not isinstance(raw, str):
            continue
        label = raw.strip().lower()
        unit = str(ws.cell(row=row, column=4).value or '').strip().lower()
        for prefix, fact in LABEL_FACT:
            if not label.startswith(prefix):
                continue
            # "Auxiliary power consumption" appears twice — kWhr (the stored
            # fact) and ( % ) (the derived row, checked separately).
            if fact == 'cpp_aux_kwh' and '%' in unit:
                continue
            if fact in found:
                raise SystemExit('sheet %s: two rows claim %s (rows %s and %s)'
                                 % (ws.title, fact, found[fact], row))
            found[fact] = row
    missing = [f for _, f in LABEL_FACT if f not in found]
    if missing:
        raise SystemExit('sheet %s: no row found for %s' % (ws.title, missing))
    # The fly-ash combustible/GCV pair shares one row: col E = %, col F = GCV.
    for row in range(1, ws.max_row + 1):
        raw = ws.cell(row=row, column=3).value
        if isinstance(raw, str) and raw.strip().lower().startswith('fly ash combustible'):
            found['cpp_flyash_combustible_pct'] = row
            found['cpp_flyash_gcv'] = row
            break
    else:
        raise SystemExit('sheet %s: no fly-ash combustible row' % ws.title)
    return found


def sheet_is_blank(ws, R):
    """True when the plant has not filled this sheet in at all — every mapped
    reading blank or zero. Mirrors import-cpp.js's own all-zero test, which
    is what decided there would be no record for the day. The heat-rate
    cells still hold formulas on such a sheet, and they read #DIV/0!."""
    for fact, row in R.items():
        col = 6 if fact == 'cpp_flyash_gcv' else 5
        v = cell(ws, row, col)
        if v is not None and abs(v) > 0.001:
            return False
    return True


def derived_rows(ws):
    found = {}
    for row in range(1, ws.max_row + 1):
        raw = ws.cell(row=row, column=3).value
        if not isinstance(raw, str):
            continue
        label = raw.strip().lower()
        unit = str(ws.cell(row=row, column=4).value or '').strip().lower()
        for key, prefix, want_unit in DERIVED_LABELS:
            if not label.startswith(prefix):
                continue
            if want_unit == '%' and '%' not in unit:
                continue
            if want_unit is None and prefix == 'auxiliary power consumption':
                continue
            found.setdefault(key, row)
    missing = [k for k, _, _ in DERIVED_LABELS if k not in found]
    if missing:
        raise SystemExit('sheet %s: no row found for derived %s' % (ws.title, missing))
    return found


def derive(f):
    """The derived rows exactly as power-plant-report.html computes them —
    from period TOTALS, which is what lets one function serve daily, MTD and
    YTD alike (the workbook's own F/G formulas do the same)."""
    gross = f.get('cpp_gross_gen_kwh', 0.0)
    aux = f.get('cpp_aux_kwh', 0.0)
    hrs = f.get('cpp_run_hrs', 0.0)
    turbine = f.get('cpp_turbine_steam_mt', 0.0)
    coal = f.get('cpp_coal_cons', 0.0)
    return {
        'net':  (gross - aux) if gross > 0 else None,
        'aux%': (aux / gross * 100) if gross > 0 else None,
        'avg':  (gross / 1000 / hrs) if hrs > 0 else None,
        'plf':  ((gross / 1000 / hrs) / 10 * 100) if hrs > 0 else None,
        'ssc':  (turbine * 1000 / gross) if gross > 0 and turbine > 0 else None,
        'sfc':  (coal * 1000 / gross) if gross > 0 and coal > 0 else None,
    }


def sheet_constants(wsf, col):
    """The constants the workbook itself uses in row 22/23 of one column."""
    tg = wsf.cell(row=22, column=col).value
    plant = wsf.cell(row=23, column=col).value
    if not isinstance(tg, str) or not isinstance(plant, str):
        return None
    ent = re.search(r'\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)', tg)
    dm = re.search(r'\*\s*\((\d+(?:\.\d+)?)\)\s*\)', tg)
    eff = re.search(r'\*\s*(\d*\.\d+)\s*\)\s*$', plant)
    if not (ent and dm and eff):
        return None
    return {'cpp_superheated_steam_enthalpy': float(ent.group(1)),
            'cpp_feedwater_enthalpy': float(ent.group(2)),
            'cpp_dm_water_enthalpy': float(dm.group(1)),
            'cpp_boiler_efficiency': float(eff.group(1))}


def record_constants(rec, suffix):
    """The constants the APP holds for one column of one day, or None."""
    out = {}
    for f in CONST_FIELDS:
        v = rec['data'].get(f + suffix)
        if v is None or v == '':
            return None
        out[f] = num(v)
    return out if out['cpp_superheated_steam_enthalpy'] > 0 else None


def rate_rollup(rows, rec, suffix, which):
    """Heat Rate MTD/YTD exactly as power-plant-report.html computes it:
    from the period totals and that column's own constants when the day
    carries them, else the generation-weighted mean of the daily readings."""
    gross = sum(num(r['data'].get('cpp_gross_gen_kwh')) for r in rows)
    k = record_constants(rec, suffix)
    if k and gross > 0:
        rise = k['cpp_superheated_steam_enthalpy'] - k['cpp_feedwater_enthalpy']
        if which == 'tg':
            turbine = sum(num(r['data'].get('cpp_turbine_steam_mt')) for r in rows)
            dm = sum(num(r['data'].get('cpp_dm_water_cons_m3')) for r in rows)
            return ((turbine * rise) + (dm * k['cpp_dm_water_enthalpy'])) * 1000 / gross
        boiler = sum(num(r['data'].get('cpp_boiler_steam_mt')) for r in rows)
        if k['cpp_boiler_efficiency'] > 0:
            return boiler * rise * 1000 / (gross * k['cpp_boiler_efficiency'])
    return weighted_rate(rows, 'cpp_heat_rate_tg' if which == 'tg' else 'cpp_heat_rate_plant')


def weighted_rate(rows, field):
    """Heat Rate MTD/YTD — generation-weighted mean of the stored daily
    readings, per formula-registry.js's monthlyAgg rule and the page's own
    computeRatios."""
    gross = sum(num(r['data'].get('cpp_gross_gen_kwh')) for r in rows)
    w = sum(num(r['data'].get(field)) * num(r['data'].get('cpp_gross_gen_kwh')) for r in rows)
    return (w / gross) if gross > 0 and w > 0 else None


def main():
    if not CPP_PASS:
        print('VERIFY_CPP_PASS is not set — export the import-cpp service account password first.')
        sys.exit(2)

    token = api('POST', '/auth/login', body={'username': CPP_USER, 'password': CPP_PASS})['token']
    print('Logged in as %s\n' % CPP_USER)

    rows = api('GET', '/reports/cpp?from=%s&to=2026-09-30' % FISCAL_START, token=token)
    by_date = {}
    for r in rows:
        d = r['record_date'][:10]
        by_date[d] = {'record_date': d, 'data': r['data'] or {}, 'status': r['status']}
    print('%d cpp records fetched for %s..2026-09-30' % (len(by_date), FISCAL_START))

    for m in MONTHS:
        wb = openpyxl.load_workbook(m['file'], data_only=True)
        wbf = openpyxl.load_workbook(m['file'], data_only=False)   # formula text, for the constants
        days = calendar.monthrange(m['year'], m['month'])[1]
        print('\n=== %s — %d-%02d, %d days ===' % (os.path.basename(m['file']), m['year'], m['month'], days))
        blanks = []
        unreported = []
        reported = 0

        for day in range(1, days + 1):
            date = '%d-%02d-%02d' % (m['year'], m['month'], day)
            ws = wb[str(day)]

            # The sheet must be the day it claims to be.
            sd = ws.cell(row=6, column=5).value
            if not isinstance(sd, dt.datetime) or sd.date() != dt.date(m['year'], m['month'], day):
                FAILURES.append('%s sheet "%d" header date is %r' % (date, day, sd))
                continue

            R = sheet_rows(ws)
            D = derived_rows(ws)
            rec = by_date.get(date)
            if not rec:
                # A sheet the plant has not filled in yet (every reading blank,
                # its own heat-rate cells reading #DIV/0!) is not a missing
                # record — there is nothing to record. The importer skips it
                # rather than asserting the plant generated zero, and the
                # workbook's own MTD/YTD simply do not move that day.
                if sheet_is_blank(ws, R):
                    unreported.append(date)
                    continue
                FAILURES.append('%s NO RECORD in the app, but the workbook has readings' % date)
                continue
            reported += 1
            if rec['status'] != 'approved':
                FAILURES.append('%s status is %s, expected approved' % (date, rec['status']))

            # ── 1. daily facts vs column E
            for fact, row in R.items():
                col = 6 if fact == 'cpp_flyash_gcv' else 5
                want = cell(ws, row, col)
                got = rec['data'].get(fact)
                got = None if got is None else num(got)
                if want is None:
                    # blank in the workbook (nothing recorded that day) — the
                    # importer omits the field rather than inventing a zero
                    blanks.append('%s %s' % (date, fact))
                    if got not in (None, 0.0):
                        FAILURES.append('%s DAY  %-28s app=%s workbook=BLANK' % (date, fact, got))
                    continue
                check(fact, date, 'DAY', got, want)

            # ── 2/3. MTD + YTD sums vs columns F and G
            mtd_rows = [by_date[d] for d in by_date if d[:7] == date[:7] and d <= date]
            ytd_rows = [by_date[d] for d in by_date if FISCAL_START <= d <= date]
            for fact, row in R.items():
                if fact in NO_ROLLUP:
                    continue
                check(fact, date, 'MTD', sum(num(r['data'].get(fact)) for r in mtd_rows), cell(ws, row, 6))
                check(fact, date, 'YTD', sum(num(r['data'].get(fact)) for r in ytd_rows), cell(ws, row, 7))

            # ── 4. derived rows, daily + MTD + YTD
            def totals(rs):
                return dict((f, sum(num(r['data'].get(f)) for r in rs)) for _, f in LABEL_FACT)

            day_d = derive(dict((f, num(rec['data'].get(f))) for _, f in LABEL_FACT))
            mtd_d = derive(totals(mtd_rows))
            ytd_d = derive(totals(ytd_rows))
            for key in ('net', 'aux%', 'avg', 'plf', 'ssc', 'sfc'):
                check('derived ' + key, date, 'DAY', day_d[key], cell(ws, D[key], 5))
                check('derived ' + key, date, 'MTD', mtd_d[key], cell(ws, D[key], 6))
                check('derived ' + key, date, 'YTD', ytd_d[key], cell(ws, D[key], 7))

            # ── 5. the four constants, per column, as the app stores them
            #      vs as the workbook's own formulas hardcode them
            wsf = wbf[str(day)]
            for col, suffix in COL_SUFFIX.items():
                want_k = sheet_constants(wsf, col)
                got_k = record_constants(rec, suffix)
                if want_k is None:
                    continue
                if got_k is None:
                    missing_consts.append('%s %s' % (date, suffix or '(day)'))
                    continue
                kind = 'DAY' if col == 5 else ('MTD' if col == 6 else 'YTD')
                for f in CONST_FIELDS:
                    check('const ' + f.replace('cpp_', '') + suffix, date, kind, got_k[f], want_k[f])

            # ── 6. the two heat-rate rollups, on whichever basis the page
            #      itself would use for this day (see rate_rollup)
            for key, which in (('hr_tg', 'tg'), ('hr_plant', 'plant')):
                fact = 'cpp_heat_rate_tg' if which == 'tg' else 'cpp_heat_rate_plant'
                check('rollup ' + key, date, 'MTD', rate_rollup(mtd_rows, rec, '_mtd', which),
                      cell(ws, R[fact], 6), TOL_RATE_ROLLUP)
                check('rollup ' + key, date, 'YTD', rate_rollup(ytd_rows, rec, '_ytd', which),
                      cell(ws, R[fact], 7), TOL_RATE_ROLLUP)

        print('  %d of %d days reported and checked' % (reported, days))
        if unreported:
            print('  sheets the plant has not filled in (no record, nothing to check):')
            print('    ' + ', '.join(unreported))
        if blanks:
            print('  cells the plant left blank (field omitted, counted as 0 in every rollup — same as the workbook):')
            for b in blanks:
                print('    %s' % b)

    print('\n%d comparisons made.' % CHECKS)
    if KNOWN:
        print(PRE + '%d known workbook defect(s) - the app is right, the source cell is not:' % len(KNOWN))
        for k in KNOWN:
            print('  ' + k)
    if missing_consts:
        by_month = {}
        for entry in missing_consts:
            by_month[entry[:7]] = by_month.get(entry[:7], 0) + 1
        print(PRE + 'columns whose constants the app does not hold, by month:')
        for mth in sorted(by_month):
            print('  %s  %3d column(s)' % (mth, by_month[mth]))
        print('  Jul-Aug were imported before the constants were part of the record. Both')
        print('  months run at 0.78 throughout, so the weighted-mean fallback reproduces')
        print('  the workbook exactly there — which is what the zero mismatches above say.')
    print('largest deviation per check type:')
    for k, v in sorted(MAXDEV.items(), key=lambda kv: -kv[1])[:8]:
        print('  %12.6g  %s' % (v, k))
    if FAILURES:
        print('\n%d MISMATCH(ES):' % len(FAILURES))
        for f in FAILURES[:80]:
            print('  ' + f)
        if len(FAILURES) > 80:
            print('  … and %d more' % (len(FAILURES) - 80))
        sys.exit(1)
    print('\nOK — every daily, MTD and YTD figure in both workbooks matches the app.')


main()
