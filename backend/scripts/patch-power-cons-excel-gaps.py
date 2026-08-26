#!/usr/bin/env python3
"""
patch-power-cons-excel-gaps.py — fills power-cons fields that
import-power-cons.js (ExcelJS) missed because ExcelJS doesn't expose a
cached result for some shared-formula cells (same defect class as rows
28/34, confirmed here on row 24 "TANESCO UNIT", 2026-04-02: a shared
formula referencing row 3 with no per-cell cached result under ExcelJS,
even though openpyxl's data_only=True read returns the true value, 0,
straight from the cell's stored <v>).

Re-derives all facts via openpyxl (reliable cache reads) for all 91 days,
and for any date+field where the live record is missing a key that the
source workbook actually has a value for, GETs the existing record,
merges in just that field, and POSTs it back. Never overwrites a field
that already has a value — only fills genuine gaps.

Usage: python backend/scripts/patch-power-cons-excel-gaps.py
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

MONTHS = [
    {'file': os.path.join(ROOT, 'master power report April, May and June', 'Copy of IMS Report of APRIL 2026_.xlsx'), 'year': 2026, 'month': 4, 'days': 30},
    {'file': os.path.join(ROOT, 'master power report April, May and June', 'Copy of IMS Report of MAY 2026.xlsx'), 'year': 2026, 'month': 5, 'days': 31},
    {'file': os.path.join(ROOT, 'master power report April, May and June', 'Copy of IMS Report of JUNE 2026.xlsx'), 'year': 2026, 'month': 6, 'days': 30},
]

LABEL_FACT = {
    'CRUSHER & AUXILIRIES': 'pwr_crusher_kwh', 'RAW MILL-1': 'pwr_rawmill_kwh',
    'RAW MILL-2': 'pwr_rawmill2_kwh', 'COAL MILL': 'pwr_coalmill_kwh', 'KILN': 'pwr_kiln_kwh',
    'CEMENT MILL-1': 'pwr_cm1_kwh', 'CEMENT MILL-2': 'pwr_cm2_kwh',
    'PACKING PLANT-1': 'pwr_packing_kwh', 'PACKING PLANT-2': 'pwr_packing2_kwh',
    'UTILITIES': 'pwr_utils_kwh', 'COLONY': 'pwr_colony_kwh', 'TANESCO UNIT': 'pwr_tanesco_kwh',
    'CPP UNIT': 'pwr_cpp_kwh', 'TANESCO UNITS FOR CLINKER': 'pwr_tanesco_clinker_kwh',
    'CPP UNIT FOR CLINKER': 'pwr_cpp_clinker_kwh', 'TANESCO UNITS FOR CEMENT': 'pwr_tanesco_cement_kwh',
    'CPP UNIT FOR CEMENT': 'pwr_cpp_cement_kwh', 'CPP UNIT FOR COLONY': 'pwr_cpp_colony_kwh',
    'TANESCO UNIT FOR COLONY': 'pwr_tanesco_colony_kwh',
}
CONSTANT_FORMULA_FACTS = {'pwr_tanesco_clinker_kwh', 'pwr_tanesco_colony_kwh'}


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
    rows = {}
    for r in range(1, 40):
        label = norm(ws_values.cell(row=r, column=1).value)
        if label in LABEL_FACT:
            rows[LABEL_FACT[label]] = r
    return rows


def round2(n):
    return round(n * 100) / 100


def api(method, pathname, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{API}{pathname}', data=data, method=method,
                                  headers={'Authorization': f'Bearer {token}',
                                           **({'Content-Type': 'application/json'} if data else {})})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode()) if e.fp else None


def login():
    if not PM_PASS:
        print("Set VERIFY_PM_PASS in the environment before running.", file=sys.stderr)
        sys.exit(1)
    status, body = api('POST', '/auth/login', None, {'username': PM_USER, 'password': PM_PASS})
    if status != 200:
        print(f"Login failed: {status} {body}", file=sys.stderr)
        sys.exit(1)
    print(f"Logged in as {PM_USER} (role {body['user']['role']})")
    return body['token']


def main():
    token = login()
    patched, checked, failed = 0, 0, 0

    for m in MONTHS:
        wb_values = openpyxl.load_workbook(m['file'], data_only=True)
        wb_formula = openpyxl.load_workbook(m['file'], data_only=False)
        cd_values = wb_values['CUMULATIVE DAILY']
        cd_formula = wb_formula['CUMULATIVE DAILY']
        fact_rows = locate_fact_rows(cd_values)

        for day in range(1, m['days'] + 1):
            col = day + 1
            date_str = f"{m['year']}-{m['month']:02d}-{day:02d}"
            checked += 1

            status, record = api('GET', f'/reports/power-cons/{date_str}', token)
            if status != 200 or not record or not record.get('data'):
                continue
            actual = record['data']

            gaps = {}
            for fact, row in fact_rows.items():
                if fact in actual:
                    continue
                v = resolve_special(cd_formula, row, col) if fact in CONSTANT_FORMULA_FACTS else num(cd_values, row, col)
                if v is not None:
                    gaps[fact] = round2(v)

            if not gaps:
                continue

            merged = {**actual, **gaps}
            r_status, r_body = api('POST', '/reports/power-cons', token, {'date': date_str, 'data': merged})
            if r_status >= 300:
                failed += 1
                print(f"  FAILED {date_str}: {r_status} {r_body}")
            else:
                patched += 1
                print(f"  patched {date_str}: filled {list(gaps.keys())}")

    print(f"\nDone. checked={checked} patched={patched} failed={failed}")
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
