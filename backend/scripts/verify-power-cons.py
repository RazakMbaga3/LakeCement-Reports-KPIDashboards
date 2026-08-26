#!/usr/bin/env python3
"""
verify-power-cons.py — INDEPENDENT full-coverage verification of the
`power-cons` form_type, separate from import-power-cons.js's own logic.

Re-derives all facts fresh from the three "Copy of IMS Report of <MONTH>
2026.xlsx" workbooks for EVERY day of 2026-04-01..2026-06-30 (91 dates),
diffing against a fresh GET from the local API. Unlike import-power-cons.js
(which hardcodes ROW_FACT row numbers), this locates each section's row by
scanning column A labels fresh per workbook — catches a row-shift bug the
hardcoded version couldn't see itself.

Also verifies the 3 patched tonnage fields (pwr_kiln_prod_mt/pwr_cm1_prod_mt/
pwr_cm2_prod_mt) against the already-verified `production` record for the
same date (they are defined as copies/sums of production's own fields, not
independently sourced from the power workbook — see
patch-power-production-tonnage.js), and does a one-time sanity check that
CUMULATIVE DAILY's stale year-2025 date header still aligns, column-for-
column, with IMS DATA's correct 2026 dates (confirms, doesn't assume, that
using column position as day-of-month is safe).

Usage: python backend/scripts/verify-power-cons.py
Requires: VERIFY_PM_USER (default import-pm), VERIFY_PM_PASS
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
import openpyxl
import warnings
warnings.filterwarnings('ignore')

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
API = os.environ.get('VERIFY_BASE_URL', 'http://localhost:5000/api')

PM_USER = os.environ.get('VERIFY_PM_USER', 'import-pm')
PM_PASS = os.environ.get('VERIFY_PM_PASS')

TOLERANCE = 0.005

MONTHS = [
    {'file': os.path.join(ROOT, 'master power report April, May and June', 'Copy of IMS Report of APRIL 2026_.xlsx'), 'year': 2026, 'month': 4, 'days': 30},
    {'file': os.path.join(ROOT, 'master power report April, May and June', 'Copy of IMS Report of MAY 2026.xlsx'), 'year': 2026, 'month': 5, 'days': 31},
    {'file': os.path.join(ROOT, 'master power report April, May and June', 'Copy of IMS Report of JUNE 2026.xlsx'), 'year': 2026, 'month': 6, 'days': 30},
]

LABEL_FACT = {
    'CRUSHER & AUXILIRIES': 'pwr_crusher_kwh',
    'RAW MILL-1': 'pwr_rawmill_kwh',
    'RAW MILL-2': 'pwr_rawmill2_kwh',
    'COAL MILL': 'pwr_coalmill_kwh',
    'KILN': 'pwr_kiln_kwh',
    'CEMENT MILL-1': 'pwr_cm1_kwh',
    'CEMENT MILL-2': 'pwr_cm2_kwh',
    'PACKING PLANT-1': 'pwr_packing_kwh',
    'PACKING PLANT-2': 'pwr_packing2_kwh',
    'UTILITIES': 'pwr_utils_kwh',
    'COLONY': 'pwr_colony_kwh',
    'TANESCO UNIT': 'pwr_tanesco_kwh',
    'CPP UNIT': 'pwr_cpp_kwh',
    'TANESCO UNITS FOR CLINKER': 'pwr_tanesco_clinker_kwh',
    'CPP UNIT FOR CLINKER': 'pwr_cpp_clinker_kwh',
    'TANESCO UNITS FOR CEMENT': 'pwr_tanesco_cement_kwh',
    'CPP UNIT FOR CEMENT': 'pwr_cpp_cement_kwh',
    'CPP UNIT FOR COLONY': 'pwr_cpp_colony_kwh',
    'TANESCO UNIT FOR COLONY': 'pwr_tanesco_colony_kwh',
}
# These two rows carry formulas that (per prior investigation) almost never
# have a cached result in the workbook — resolved via their formula text
# instead, independently of any cached value, mirroring the special-cased
# rows 28/34 in import-power-cons.js's resolveConstantFormula().
CONSTANT_FORMULA_FACTS = {'pwr_tanesco_clinker_kwh', 'pwr_tanesco_colony_kwh'}

CM1_FIELDS = ['cm1_425r_mt', 'cm1_325n_mt', 'cm1_425n_mt', 'cm1_opc_mt']
CM2_FIELDS = ['cm2_425r_mt', 'cm2_325n_mt', 'cm2_425n_mt', 'cm2_425n_bm_mt']


def norm(v):
    return ' '.join(str(v).split()).upper() if v is not None else ""


def num(ws, row, col):
    v = ws.cell(row=row, column=col).value
    return v if isinstance(v, (int, float)) else None


def resolve_constant_formula(formula_text):
    f = formula_text.lstrip('=').strip()
    if re.fullmatch(r'[\d.\s+-]+', f):
        try:
            return eval(f, {'__builtins__': {}})
        except Exception:
            return None
    m = re.search(r'\+(\d+(?:\.\d+)?)\s*$', f)
    return float(m.group(1)) if m else 0.0


def resolve_special(ws_formula, row, col):
    raw = ws_formula.cell(row=row, column=col).value
    if isinstance(raw, (int, float)):
        return raw
    if isinstance(raw, str) and raw.startswith('='):
        return resolve_constant_formula(raw)
    return None


def locate_fact_rows(ws_values):
    """Independently scan column A for each known section label; returns
    {fact: row}. A label not found is reported, not silently skipped."""
    rows = {}
    for r in range(1, 40):
        label = norm(ws_values.cell(row=r, column=1).value)
        if label in LABEL_FACT:
            rows[LABEL_FACT[label]] = r
    return rows


def round2(n):
    return round(n * 100) / 100


def api_get(pathname, token):
    req = urllib.request.Request(f'{API}{pathname}', headers={'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def login():
    if not PM_PASS:
        print("Set VERIFY_PM_PASS in the environment before running.", file=sys.stderr)
        sys.exit(1)
    body = json.dumps({'username': PM_USER, 'password': PM_PASS}).encode()
    req = urllib.request.Request(f'{API}/auth/login', data=body,
                                  headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req) as resp:
        payload = json.loads(resp.read().decode())
    print(f"Logged in as {PM_USER} (role {payload['user']['role']})")
    return payload['token']


def check_date_alignment(m):
    """One-time sanity check (April only, where the stale-year issue was
    seen): CUMULATIVE DAILY's day-of-month per column must match IMS DATA's
    real 2026 date in the same column, ignoring CUMULATIVE DAILY's stale
    year label."""
    wb = openpyxl.load_workbook(m['file'], data_only=True)
    cd, ims = wb['CUMULATIVE DAILY'], wb['IMS DATA']
    mismatches = []
    for day in range(1, m['days'] + 1):
        col = day + 1
        cd_date = cd.cell(row=1, column=col).value
        ims_date = ims.cell(row=1, column=col).value
        if cd_date is None or ims_date is None:
            continue
        if (cd_date.month, cd_date.day) != (ims_date.month, ims_date.day):
            mismatches.append((day, cd_date, ims_date))
    label = 'stale year, but day/month aligned' if (mismatches == [] and
        any(cd.cell(row=1, column=c).value and cd.cell(row=1, column=c).value.year != m['year']
            for c in range(2, m['days'] + 2))) else ('OK' if not mismatches else 'MISALIGNED')
    print(f"  {m['year']}-{m['month']:02d}: CUMULATIVE DAILY vs IMS DATA day/month alignment: {label}")
    if mismatches:
        for day, cd_d, ims_d in mismatches:
            print(f"    day {day}: CUMULATIVE DAILY={cd_d} vs IMS DATA={ims_d}")
    return len(mismatches) == 0


def main():
    token = login()

    print("=== DATE-ALIGNMENT SANITY CHECK ===\n")
    align_ok = True
    for m in MONTHS:
        align_ok = check_date_alignment(m) and align_ok

    print("\n=== FULL-COVERAGE VERIFICATION — 91/91 days, fresh GET vs fresh Excel re-derivation ===\n")
    match, mismatch, missing = 0, 0, 0
    mismatches = []
    utils_present_count, utils_absent_count = 0, 0

    for m in MONTHS:
        wb_values = openpyxl.load_workbook(m['file'], data_only=True)
        wb_formula = openpyxl.load_workbook(m['file'], data_only=False)
        cd_values = wb_values['CUMULATIVE DAILY']
        cd_formula = wb_formula['CUMULATIVE DAILY']
        fact_rows = locate_fact_rows(cd_values)
        unresolved = [lbl for lbl, fact in LABEL_FACT.items() if fact not in fact_rows]
        if unresolved:
            print(f"  WARNING ({m['file']}): labels not found: {unresolved}")

        for day in range(1, m['days'] + 1):
            col = day + 1
            date_str = f"{m['year']}-{m['month']:02d}-{day:02d}"
            expected = {}
            for fact, row in fact_rows.items():
                if fact in CONSTANT_FORMULA_FACTS:
                    v = resolve_special(cd_formula, row, col)
                else:
                    v = num(cd_values, row, col)
                if v is not None:
                    expected[fact] = round2(v)

            record = api_get(f'/reports/power-cons/{date_str}', token)
            actual = (record or {}).get('data', {})

            if 'pwr_utils_kwh' in actual:
                utils_present_count += 1
            else:
                utils_absent_count += 1

            d_match = d_mismatch = d_missing = 0
            for k, v in expected.items():
                av = actual.get(k)
                if av is None:
                    d_missing += 1
                    mismatches.append((date_str, k, v, None, 'MISSING_DATA'))
                else:
                    try:
                        if abs(float(av) - float(v)) < TOLERANCE:
                            d_match += 1
                        else:
                            d_mismatch += 1
                            mismatches.append((date_str, k, v, av, 'MAPPING_BUG'))
                    except (TypeError, ValueError):
                        d_mismatch += 1
                        mismatches.append((date_str, k, v, av, 'MAPPING_BUG'))
            match += d_match; mismatch += d_mismatch; missing += d_missing
            status = 'OK' if (d_mismatch == 0 and d_missing == 0) else 'ISSUES'
            print(f"  {date_str}: {len(expected):2d} fields -> match={d_match} mismatch={d_mismatch} missing={d_missing}  [{status}]")

    print(f"\nTOTAL: match={match} mismatch={mismatch} missing={missing}")
    if mismatches:
        print("\nDetails:")
        for d, k, exp, act, cat in mismatches:
            print(f"  [{cat}] {d} {k}: expected={exp} actual={act}")

    print(f"\npwr_utils_kwh presence check: present on {utils_present_count}/91 records, "
          f"absent on {utils_absent_count}/91 — header comment in import-power-cons.js claims "
          f"this field was removed and 'no longer submitted'; report the true state above for a decision.")

    print("\n=== TONNAGE CROSS-CHECK — patched pwr_kiln/cm1/cm2_prod_mt vs already-verified production record ===\n")
    tonnage_match, tonnage_mismatch, tonnage_missing = 0, 0, 0
    tonnage_mismatches = []
    for m in MONTHS:
        for day in range(1, m['days'] + 1):
            date_str = f"{m['year']}-{m['month']:02d}-{day:02d}"
            prod_record = api_get(f'/reports/production/{date_str}', token)
            prod = (prod_record or {}).get('data', {})
            pc_record = api_get(f'/reports/power-cons/{date_str}', token)
            pc = (pc_record or {}).get('data', {})

            checks = []
            if 'kiln_prod_mt' in prod:
                checks.append(('pwr_kiln_prod_mt', round2(prod['kiln_prod_mt'])))
            cm1_vals = [prod[f] for f in CM1_FIELDS if f in prod]
            if cm1_vals:
                checks.append(('pwr_cm1_prod_mt', round2(sum(cm1_vals))))
            cm2_vals = [prod[f] for f in CM2_FIELDS if f in prod]
            if cm2_vals:
                checks.append(('pwr_cm2_prod_mt', round2(sum(cm2_vals))))

            for fact, expected_v in checks:
                actual_v = pc.get(fact)
                if actual_v is None:
                    tonnage_missing += 1
                    tonnage_mismatches.append((date_str, fact, expected_v, None, 'MISSING_DATA'))
                elif abs(float(actual_v) - expected_v) < TOLERANCE:
                    tonnage_match += 1
                else:
                    tonnage_mismatch += 1
                    tonnage_mismatches.append((date_str, fact, expected_v, actual_v, 'MAPPING_BUG'))

    print(f"  TOTAL: match={tonnage_match} mismatch={tonnage_mismatch} missing={tonnage_missing}")
    if tonnage_mismatches:
        print("\n  Details:")
        for d, k, exp, act, cat in tonnage_mismatches:
            print(f"    [{cat}] {d} {k}: expected={exp} actual={act}")

    overall_fail = (mismatch or missing or tonnage_mismatch or tonnage_missing or not align_ok)
    sys.exit(1 if overall_fail else 0)


if __name__ == '__main__':
    main()
