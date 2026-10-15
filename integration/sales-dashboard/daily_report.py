"""Daily e-mail: sales vs target (MTD) per customer, one mail per salesperson.

Data comes live from Odoo: each customer of the salesperson with MTD sales (MT) or a month target (MT) - customers
with both zero are left out; same figures as the dashboard's Budget vs Actual tab. Recipients come from
outbox\\Salesperson Matrix.xlsx (Salesperson, Sales person Email = To, every "... Manager" and "Back office" column = CC; several
addresses per cell allowed), or email_master.csv when that workbook is missing.
This script only writes the mails to outbox\\<date>\\ (manifest.json + one HTML per mail);
send_outlook.ps1 sends them through Outlook. Run both via daily_report.bat.

    venv\\Scripts\\python.exe daily_report.py [--date YYYY-MM-DD] [--test you@company]
Default report date = yesterday (the mail goes out in the morning). --test sends every mail to that address only.
"""
import argparse
import csv
import html
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

import mis_report as mis  # noqa: E402  (after load_dotenv)
import odoo_client  # noqa: E402

TZ = ZoneInfo(os.getenv("TIMEZONE", "Africa/Dar_es_Salaam").strip() or "Africa/Dar_es_Salaam")
COMPANY = os.getenv("COMPANY_NAME", "Lake Cement Ltd.").strip() or "Lake Cement Ltd."
ADMIN_EMAIL = os.getenv("REPORT_ADMIN_EMAIL", "mitesh.patel@lakecement.co.tz").strip()
KEYS = ["Salesperson", "Customer Code", "Customer", "Zone"]
NAVY, ORANGE, LINE = "#16305a", "#f08a24", "#e3e8ef"


def log(msg: str):
    print(f"[{datetime.now(TZ):%Y-%m-%d %H:%M:%S}] {msg}", file=sys.stderr, flush=True)


def norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().upper()


MATRIX_XLSX = HERE / "outbox" / "Salesperson Matrix.xlsx"  # maintained by the user; email_master.csv is the fallback
EMAIL_RE = re.compile(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+")


def emails(cell) -> list[str]:
    """'a@x.com; b@y.com' (any separator) -> ['a@x.com', 'b@y.com']."""
    return EMAIL_RE.findall(str(cell or ""))


def load_master() -> dict:
    """Salesperson -> {"to": [...], "cc": [...]}. Columns found by header text (any spacing / case):
    Salesperson, '... Email' (To), every '... Manager' column (CC). Cells may hold several addresses."""
    if MATRIX_XLSX.exists():
        import openpyxl
        ws = openpyxl.load_workbook(MATRIX_XLSX, read_only=True, data_only=True).active
        table = [list(r) for r in ws.iter_rows(values_only=True) if any(v is not None for v in r)]
    else:
        with open(HERE / "email_master.csv", encoding="utf-8-sig", newline="") as f:
            table = list(csv.reader(f))
    head = [norm(h) for h in table[0]]
    sp_col = next(i for i, h in enumerate(head) if h == "SALESPERSON")
    to_col = next(i for i, h in enumerate(head) if "EMAIL" in h)
    cc_cols = [i for i, h in enumerate(head) if "MANAGER" in h or "BACK OFFICE" in h or "BACKOFFICE" in h]
    master = {}
    for r in table[1:]:
        if not r[sp_col]:
            continue
        to = emails(r[to_col])
        cc = [e for i in cc_cols for e in emails(r[i])]
        master[norm(r[sp_col])] = {"to": to, "cc": cc}
    return master


def fetch(d: date, tries: int = 3, wait: int = 600):
    """Odoo data with retries (10 minutes apart) so a short outage does not skip the day's mail."""
    mf = mis.month_facts(d)
    for n in range(1, tries + 1):
        try:
            targets = odoo_client.fetch_targets(mf["start"], mf["start"])
            register = odoo_client.fetch_register(mf["start"], d)
            break
        except odoo_client.OdooError as e:
            log(f"Odoo attempt {n}/{tries} failed: {e}")
            if n == tries:
                raise
            time.sleep(wait)
    # same figures as the dashboard; customers with neither target nor sales are left out by budget_vs_actual
    df = mis.budget_vs_actual(targets, register, d, "customer")[KEYS + ["MTD Actual (MT)", "Month Target (MT)"]]
    df = df.rename(columns={"MTD Actual (MT)": "sales", "Month Target (MT)": "target"})
    df = df[(df.sales.round(2) != 0) | (df.target.round(2) != 0)]
    df = df.sort_values(["Salesperson", "sales", "target", "Customer"], ascending=[True, False, False, True])
    return df, mf, set(df.Salesperson)


def mt(v) -> str:
    return "-" if v != v or round(v, 2) == 0 else f"{v:,.2f}"


def pct(sales, target) -> str:
    return f"{sales / target * 100:,.0f}%" if target else "0%"


def mail_html(sp: str, df: pd.DataFrame, d: date, mf: dict) -> str:
    mon = f"{d:%b}'{d:%Y}"
    cols = [("Odoo Code", "left"), ("Customer/Firm/Agency Name", "left"), ("Zone", "left"),
            (f"Sales ({mon})", "right"), (f"Target ({mon})", "right"), ("% TARGET", "right")]
    sales, target = df.sales.sum(), df.target.sum()
    th = "".join(f'<th style="background:{NAVY};color:#fff;padding:7px 10px;border:1px solid {NAVY};'
                 f'text-align:{a}">{html.escape(c)}</th>' for c, a in cols)
    td = f"padding:6px 10px;border:1px solid {LINE};"
    body = "".join(
        f'<tr><td style="{td}">{html.escape(r["Customer Code"])}</td><td style="{td}">{html.escape(r.Customer)}</td>'
        f'<td style="{td}">{html.escape(r.Zone)}</td><td style="{td}text-align:right">{mt(r.sales)}</td>'
        f'<td style="{td}text-align:right">{mt(r.target)}</td>'
        f'<td style="{td}text-align:right">{pct(r.sales, r.target)}</td></tr>' for _, r in df.iterrows())
    tot = (f'<tr style="font-weight:700;background:#f4f6fa"><td style="{td}" colspan="3">Total ({len(df)} customers)</td>'
           f'<td style="{td}text-align:right">{mt(sales)}</td><td style="{td}text-align:right">{mt(target)}</td>'
           f'<td style="{td}text-align:right">{pct(sales, target)}</td></tr>')
    return f"""<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1f2d3d">
<p>Dear {html.escape(" ".join(sp.split()).title())},</p>
<p>Please find your customer-wise <b>Sales vs Target</b> for <b>{mf['start']:%B %Y}</b> up to <b>{d:%d %b %Y}</b>
(day {mf['elapsed']} of {mf['days']}). Quantities in MT.</p>
<p><b>Sales: {mt(sales)} MT &nbsp;·&nbsp; Target: {mt(target)} MT &nbsp;·&nbsp;
<span style="color:{ORANGE}">Achievement: {pct(sales, target)}</span></b></p>
<table style="border-collapse:collapse;font-size:12.5px"><tr>{th}</tr>{body}{tot}</table>
<br>
<p>Regards,<br>Sales &amp; Marketing - {html.escape(COMPANY)}<br>LCL Back Office</p></div>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="report date YYYY-MM-DD (default: yesterday)")
    ap.add_argument("--test", help="send every mail to this address only (no CC)")
    a = ap.parse_args()
    d = date.fromisoformat(a.date) if a.date else datetime.now(TZ).date() - timedelta(days=1)
    d = max(d, odoo_client.DATA_START)

    master = load_master()
    df, mf, active = fetch(d)
    out = HERE / "outbox" / f"{d:%Y-%m-%d}"
    out.mkdir(parents=True, exist_ok=True)
    mails, missing = [], []
    for sp, g in df.groupby("Salesperson", sort=True):
        rec = master.get(norm(sp))
        if not rec or not rec["to"]:
            if sp in active:  # has target or sales this month but nobody to send it to
                missing.append(sp)
            continue
        to = list(dict.fromkeys(rec["to"]))
        cc = [c for c in dict.fromkeys(rec["cc"] + [ADMIN_EMAIL]) if c.lower() not in {t.lower() for t in to}]  # admin always gets a copy
        f = out / (re.sub(r"[^A-Za-z0-9]+", "_", sp).strip("_") + ".html")
        f.write_text(mail_html(sp, g, d, mf), encoding="utf-8")
        mails.append({"salesperson": sp, "to": a.test or "; ".join(to), "cc": "" if a.test else "; ".join(cc),
                      "subject": f"Sales vs Target {d:%b}'{d:%Y} - {" ".join(sp.split()).title()} - up to {d:%d %b %Y}"
                                 + (f" [TEST, for {'; '.join(to)}]" if a.test else ""),
                      "html_file": str(f)})
    if missing:  # tell the administrator
        f = out / "_missing_email.html"
        f.write_text("<p>These salespersons have target or sales in Odoo for "
                     f"{mf['start']:%B %Y} but no e-mail in email_master.csv, so no report was sent:</p><ul>"
                     + "".join(f"<li>{html.escape(s)}</li>" for s in missing) + "</ul>", encoding="utf-8")
        mails.append({"salesperson": "(admin)", "to": a.test or ADMIN_EMAIL, "cc": "",
                      "subject": f"Daily sales report - {len(missing)} salesperson(s) without e-mail - {d:%d %b %Y}",
                      "html_file": str(f)})
    (out / "manifest.json").write_text(json.dumps(mails, indent=1), encoding="utf-8")
    log(f"report date {d}: {len(mails)} mail(s) prepared in {out}"
        + (f"; no e-mail for: {', '.join(missing)}" if missing else ""))
    print(f"MANIFEST={out / 'manifest.json'}")
    (HERE / "outbox" / "last_manifest.txt").write_text(str(out / "manifest.json"), encoding="ascii")


if __name__ == "__main__":
    try:
        main()
    except odoo_client.OdooError as e:
        log(f"ERROR: Odoo unreachable, no mails prepared: {e}")
        sys.exit(2)
