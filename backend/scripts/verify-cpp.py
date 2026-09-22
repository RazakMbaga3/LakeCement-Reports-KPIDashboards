#!/usr/bin/env python3
"""
verify-cpp.py — INDEPENDENT full-coverage verification of the `cpp`
form_type (Captive Power Plant, FRM-LCL-PP-06) for Jul-Aug 2026, separate
from import-cpp.js's own logic.

What it proves, for EVERY day of 2026-07-01..2026-08-31 (62 dates), against
a fresh GET from the local API:

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
]

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

    rows = api('GET', '/reports/cpp?from=%s&to=2026-08-31' % FISCAL_START, token=token)
    by_date = {}
    for r in rows:
        d = r['record_date'][:10]
        by_date[d] = {'record_date': d, 'data': r['data'] or {}, 'status': r['status']}
    print('%d cpp records fetched for %s..2026-08-31' % (len(by_date), FISCAL_START))

    for m in MONTHS:
        wb = openpyxl.load_workbook(m['file'], data_only=True)
        days = calendar.monthrange(m['year'], m['month'])[1]
        print('\n=== %s — %d-%02d, %d days ===' % (os.path.basename(m['file']), m['year'], m['month'], days))
        blanks = []

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
                FAILURES.append('%s NO RECORD in the app at all' % date)
                continue
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

            for key, fact in (('hr_tg', 'cpp_heat_rate_tg'), ('hr_plant', 'cpp_heat_rate_plant')):
                check('rollup ' + key, date, 'MTD', weighted_rate(mtd_rows, fact),
                      cell(ws, R[fact], 6), TOL_RATE_ROLLUP)
                check('rollup ' + key, date, 'YTD', weighted_rate(ytd_rows, fact),
                      cell(ws, R[fact], 7), TOL_RATE_ROLLUP)

        print('  %d days read' % days)
        if blanks:
            print('  cells the plant left blank (field omitted, counted as 0 in every rollup — same as the workbook):')
            for b in blanks:
                print('    %s' % b)

    print('\n%d comparisons made.' % CHECKS)
    if KNOWN:
        print(PRE + '%d known workbook defect(s) - the app is right, the source cell is not:' % len(KNOWN))
        for k in KNOWN:
            print('  ' + k)
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
