"""
Extract department-level Monthly KPI target/actual data from the
"M - 11 LCL Department KPI Report" workbooks (April/May/June 2026) into
one JSON per month, ready for import into the kpi_monthly Postgres table.

Only the 7 sheets that share the standard KPI/UNIT/SIGNAGE/TARGET/ACTUAL
layout are extracted (Mechanical, Production, E & I, Power Plant, Mines,
Packing Plant, Stores). 'Mines Workshop' (per-equipment matrix) and 'OT'
(overtime cost table) have a different shape and are not part of
kpi_monthly's (department, kpi_key) model — skipped.

Row 0 = KPI label, 1 = unit, 2 = signage, 3 = target, 4 = current-month actual,
5 = remarks. Section header rows (e.g. "HEALTH & SAFETY") have a label but no
unit/signage/target/actual and are skipped. Fully blank rows are skipped.

A few KPIs (e.g. E&I's "Calibration of Weighfeeders..." / "Regular Random
Verification of Bag Weight") are tracked as text/status, not numbers — target
and actual are things like "AS PER FREQUENCY" / "DONE" or a tolerance spec
plus a measured-weight note. Both target and actual come back None from
clean_num() for these, but the row is real and must not be silently dropped:
the text is preserved in `text_status` and folded into `remarks` so the
dashboard still shows something instead of a blank/never-populated row.
"""
import json
import re
import sys
import openpyxl

SHEET_TO_DEPT = {
    'Mechanical':     'mechanical',
    'Production':     'production',
    'E & I':          'ei',
    'Power Plant':    'powerplant',
    'Mines':          'mines',
    'Packing Plant':  'packing',
    'Stores':         'stores',
}

# KPIs owned by the formula engine (forms/formula-registry.js) — the live
# dashboard renders these from /api/formula/eval, not kpi_monthly, so writing
# a manual value here would just be dead data the UI never reads.
FORMULA_OWNED_SLUGS = {'despatch-day', 'clinker-free-lime'}

# The Excel source has two spelling typos in labels the dashboard HTML
# already spells correctly (AUXILLARY -> Auxiliary, CUMMULATIVE ->
# Cumulative). Rather than propagate the typo into a new kpi_key the
# dashboard's kpiSlug(label) will never match, alias to the dashboard's slug.
KEY_ALIASES = {
    ('powerplant', 'auxillary-power-cons'): 'auxiliary-power-consumption',
    ('powerplant', 'unplanned-stop-in-a-year-cummulative'): 'unplanned-stop-in-a-year-cumulative',
}


def slug(text):
    text = str(text).lower()
    text = re.sub(r'[^a-z0-9]+', '-', text)
    return text.strip('-')


def clean_num(v):
    """Return a float if v is numeric or a numeric-looking string, else None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s in ('', '-', '–', '—', 'NIL', 'Nil', 'N/A', '#DIV/0!'):
        return None
    s = s.replace(',', '').replace('%', '').replace('+', '')
    try:
        return float(s)
    except ValueError:
        return None


def clean_unit(v):
    if v is None:
        return ''
    return str(v).strip()[:20]  # kpi_monthly.unit is VARCHAR(20)


def clean_remark(v):
    if v is None:
        return None
    s = str(v).strip()
    if s in ('', '-', '–', '—'):
        return None
    return s


def is_blank(v):
    """None or a whitespace-only string (Excel sometimes stores '' instead
    of a truly empty cell, e.g. Stores sheet's section-header rows)."""
    return v is None or (isinstance(v, str) and v.strip() == '')


def clean_text_status(v):
    """Non-numeric target/actual text (e.g. 'DONE', 'AS PER FREQUENCY') —
    kept verbatim, just whitespace-trimmed, distinct from clean_remark's
    dash-filtering since '-' here could be part of a real spec string."""
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def extract_month(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    out = []
    for sheet_name, dept in SHEET_TO_DEPT.items():
        if sheet_name not in wb.sheetnames:
            print(f'  ! sheet missing: {sheet_name}', file=sys.stderr)
            continue
        ws = wb[sheet_name]
        for row in ws.iter_rows(min_row=1, max_row=ws.max_row, max_col=6):
            label = row[0].value
            if label is None:
                continue
            label = str(label).strip()
            if not label:
                continue
            unit_raw, signage_raw, target_raw, actual_raw, remarks_raw = (
                row[1].value, row[2].value, row[3].value, row[4].value, row[5].value
            )
            # Section header rows carry only a label (all of unit/signage/
            # target/actual blank — Excel sometimes stores '' rather than a
            # true empty cell, e.g. Stores' "OPERATIONAL"/"FINANCIAL" rows
            # have unit='') — skip. Also skip obvious title rows.
            if is_blank(unit_raw) and is_blank(signage_raw) and is_blank(target_raw) and is_blank(actual_raw):
                continue
            if label.upper() in ('LAKE CEMENT LIMITED', 'MONTHLY KEY PERFORMANCE INDICATORS (KPI)'):
                continue
            if label.upper().startswith('DEPARTMENT') or label.upper().startswith('RESPONSIBILITY'):
                continue
            if label == 'KPI':  # header row itself
                continue

            kpi_key = slug(label)
            if not kpi_key or kpi_key in FORMULA_OWNED_SLUGS:
                continue
            kpi_key = KEY_ALIASES.get((dept, kpi_key), kpi_key)

            target = clean_num(target_raw)
            actual = clean_num(actual_raw)
            remarks = clean_remark(remarks_raw)

            if target is None and actual is None:
                # Not necessarily "nothing usable" — target/actual may be
                # tracked as text/status (e.g. 'DONE', 'AS PER FREQUENCY')
                # rather than a number. Fold that text into remarks instead
                # of dropping the row, so the KPI still shows up.
                target_text = clean_text_status(target_raw)
                actual_text = clean_text_status(actual_raw)
                if target_text is None and actual_text is None:
                    continue  # genuinely nothing on this row
                status_bits = []
                if target_text: status_bits.append(f'Target: {target_text}')
                if actual_text: status_bits.append(f'Actual: {actual_text}')
                status_note = ' | '.join(status_bits)
                remarks = f'{status_note} — {remarks}' if remarks else status_note

            out.append({
                'department': dept,
                'kpi_key': kpi_key,
                'label': label,
                'unit': clean_unit(unit_raw),
                'target': target,
                'actual': actual,
                'remarks': remarks,
            })
    return out


if __name__ == '__main__':
    months = [
        ('M - 11 LCL Department KPI Report - April 2026.xlsx', 2026, 4),
        ('M - 11 LCL Department KPI Report - May  2026.xlsx', 2026, 5),
        ('M - 11 LCL Department KPI Report - Jun 2026.xlsx', 2026, 6),
    ]
    for fname, year, month in months:
        rows = extract_month(fname)
        out_path = f'kpi_monthly_{year}-{month:02d}.json'
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump({'year': year, 'month': month, 'rows': rows}, f, indent=2, ensure_ascii=False)
        print(f'{fname}: {len(rows)} rows -> {out_path}')
