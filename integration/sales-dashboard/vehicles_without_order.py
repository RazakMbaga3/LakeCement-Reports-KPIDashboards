"""Report "Vehicles At Factory Without Order" -> 'Vehicles At Factory Without Order.xlsx' in this folder.

Source: Odoo Reporting > Sale and Dispatch > SO Pendency and Vehicle Status (the vehicle / gate token side, table
custom_sale_token). Open items = tokens not yet done or cancelled and with no gate-out. "Without order" = token with no
sale order linked. Read-only, same database connection as the dashboard.
"""
import argparse
import html
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

import pandas as pd  # noqa: E402
from openpyxl import Workbook  # noqa: E402
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

import odoo_client as oc  # noqa: E402

# Scheduled mail (every 2 hours, run_vehicles_report.bat)
LIVE_TO = ("sales@lakecement.co.tz; ajit.singh@lakecement.co.tz; nirav.oza@lakecement.co.tz")
LIVE_CC = ("indra.pathak@lakecement.co.tz; lclbackoffice@lakecement.co.tz; allocation@lakecement.co.tz; "
           "sales.backoffice1@lakecement.co.tz; exports.nyati@lakecement.co.tz; bhavnesh.valand@lakecement.co.tz; "
           "jatinder.dogra@lakecement.co.tz; mrudang.vyas@lakecement.co.tz; token.office@lakecement.co.tz; "
           "mitesh.patel@lakecement.co.tz")
OUT = HERE / "Vehicles At Factory Without Order.xlsx"
STATE = {"issue": "Token issued (outside)", "allow_in": "Allowed in", "weight_in": "Weighed in",
         "loading": "Loading", "weight_out": "Weighed out", "boom_out": "At boom out"}
SQL = """
SELECT t.name, t.state, t.vehicle, t.trailer, COALESCE(t.transporter_name, ''), COALESCE(t.custom_driver_name, ''),
       COALESCE(t.driver_mobile, ''), COALESCE(NULLIF(t.product_name, ''), ''), COALESCE(t.bag_type, ''),
       COALESCE(t.delivery_qty, 0), COALESCE(t.sale_uom, ''), COALESCE(t.remarks, ''),
       t.issued_time, t.allowed_time, t.gentry_in_time, t.weight_in_time, t.loading_in_time, t.weight_out_time,
       t.boom_out_time, COALESCE(t.approval_status, ''), COALESCE(p.name, '')
FROM custom_sale_token t
LEFT JOIN res_users u ON u.id = t.user_id
LEFT JOIN res_partner p ON p.id = u.partner_id
WHERE t.state NOT IN ('done', 'cancel') AND t.gentry_out_time IS NULL AND t.order_id IS NULL
ORDER BY t.issued_time, t.id
"""
COLS = ["Token No", "State", "Vehicle", "Trailer", "Transporter", "Driver", "Driver Mobile", "Product", "Bag Type",
        "Qty", "UoM", "Remarks", "Token Issued", "Allowed In", "Gate In", "Weight In", "Loading In", "Weight Out",
        "Boom Out", "Approval", "Issued By"]
TIMES = COLS[12:19]
DROP = ["Product", "Qty", "UoM", "Remarks", "Waiting (hrs)", "Allowed In", "Gate In", "Weight In",
        "Loading In", "Weight Out", "Boom Out", "Approval", "Bag Type"]  # not wanted in the report


def fetch(remarks_layout: bool = True) -> pd.DataFrame:
    """remarks_layout: Remarks column instead of the State column (False = the previous layout)."""
    drop = [c for c in DROP if c != "Remarks"] + ["State"] if remarks_layout else DROP
    rows = oc._run(lambda con: con.run(SQL))
    df = pd.DataFrame(rows, columns=COLS)
    tz = oc._tz()
    for c in TIMES:
        df[c] = pd.to_datetime(df[c]).dt.tz_localize("UTC").dt.tz_convert(tz).dt.tz_localize(None)
    now = datetime.now(tz).replace(tzinfo=None)
    df.insert(df.columns.get_loc("Token Issued") + 1, "Waiting (hrs)",
              ((now - df["Token Issued"]).dt.total_seconds() / 3600).round(1))
    df["State"] = df["State"].map(STATE).fillna(df["State"])
    df = df.drop(columns=drop)
    return df[["Token Issued"] + [c for c in df.columns if c != "Token Issued"]]


def write(df: pd.DataFrame, path: Path):
    NAVY, thin = "1B3A6B", Side(style="thin", color="B8C4D6")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    wb = Workbook()
    ws = wb.active
    ws.title = "Vehicles Without Order"
    ncol = len(df.columns)
    ws.cell(1, 1, "Vehicles At Factory Without Order").font = Font(bold=True, size=15, color=NAVY)
    ws.cell(2, 1, f"Open items from SO Pendency and Vehicle Status: sale tokens with no sale order linked and no "
                  f"gate-out · as on {datetime.now(oc._tz()):%d %b %Y %H:%M} · {len(df)} vehicle(s)").font = Font(
        italic=True, color="5A6B85")
    hdr = 4
    for j, c in enumerate(df.columns, 1):
        cell = ws.cell(hdr, j, c)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.alignment = Alignment(horizontal="right" if j == 1 else "center", vertical="center", wrap_text=True)
        cell.border = border
    ws.row_dimensions[hdr].height = 32
    for i, r in enumerate(df.itertuples(index=False), hdr + 1):
        for j, (c, v) in enumerate(zip(df.columns, r), 1):
            if pd.isna(v):
                v = None
            elif isinstance(v, pd.Timestamp):
                v = v.to_pydatetime()
            cell = ws.cell(i, j, v)
            cell.border = border
            if i % 2 == 0:
                cell.fill = PatternFill("solid", fgColor="F3F6FB")
            if isinstance(v, datetime):
                cell.number_format, h = "dd-mm-yyyy hh:mm", "center"
            elif isinstance(v, (int, float)):
                cell.number_format, h = ("0.0" if c == "Waiting (hrs)" else "#,##0.00"), "right"
            else:
                h = "center" if c in ("State", "Vehicle", "Trailer", "UoM", "Bag Type", "Approval") else "left"
            cell.alignment = Alignment(horizontal=h, vertical="center", wrap_text=isinstance(v, str))
    for j, c in enumerate(df.columns, 1):  # per-column autofit from this table's own content
        longest = max([len(str(c)) * 1.1] + [len(v.strftime("%d-%m-%Y %H:%M")) if isinstance(v, (datetime, pd.Timestamp))
                                             else len(str(v)) for v in df[c] if not pd.isna(v)])
        ws.column_dimensions[get_column_letter(j)].width = min(40, max(9, longest + 3))
    ws.freeze_panes = ws.cell(hdr + 1, 4)
    if len(df):
        ws.auto_filter.ref = f"A{hdr}:{get_column_letter(ncol)}{hdr + len(df)}"
    else:
        ws.cell(hdr + 1, 1, "No open vehicles without an order.").font = Font(italic=True)
    wb.save(path)


def mail_html(df: pd.DataFrame) -> str:
    """Mail body: short note, summary line and the whole report as an HTML table."""
    th = ("padding:6px 10px;border:1px solid #3a5583;background:#1B3A6B;color:#fff;text-align:center;"
          "vertical-align:middle;white-space:nowrap")
    td = "padding:5px 10px;border:1px solid #cfd8e3;vertical-align:middle;"
    centre = {"Token Issued", "Token No", "State", "Vehicle", "Trailer"}
    head = "".join(f'<th style="{th}{";text-align:right" if i == 0 else ""}">{html.escape(c)}</th>'
                   for i, c in enumerate(df.columns))
    rows = ""
    for i, r in enumerate(df.itertuples(index=False)):
        bg = "background:#f3f6fb;" if i % 2 else ""
        cells = ""
        for c, v in zip(df.columns, r):
            v = "" if pd.isna(v) else (v.strftime("%d-%m-%Y %H:%M") if isinstance(v, pd.Timestamp) else str(v))
            cells += f'<td style="{td}{bg}text-align:{"center" if c in centre else "left"}">{html.escape(v)}</td>'
        rows += f"<tr>{cells}</tr>"
    if not len(df):
        rows = f'<tr><td style="{td}text-align:center" colspan="{len(df.columns)}">No open vehicles without an order.</td></tr>'
    now = datetime.now(oc._tz())
    return f"""<div style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1f2d3d">
<p>Dear Team,</p>
<p>Please find below the <b>Vehicles At Factory Without Order</b> report as on <b>{now:%d %b %Y, %H:%M}</b></p>
<table style="border-collapse:collapse;font-size:12.5px"><tr>{head}</tr>{rows}</table>
<p>Regards,<br>Sales &amp; Marketing - Lake Cement Ltd.<br>LCL Back Office</p></div>"""


PS_SEND = r"""param($To,$Subject,$Html,$Attach,$Cc="")
$o = New-Object -ComObject Outlook.Application
$m = $o.CreateItem(0)
$m.To = $To
if ($Cc) { $m.CC = $Cc }
$m.Subject = $Subject
$m.HTMLBody = Get-Content $Html -Raw -Encoding UTF8
$m.Attachments.Add($Attach) | Out-Null
$m.Send()
"sent to $To"
"""


def send(df: pd.DataFrame, to: str, test: bool, cc: str = ""):
    out = HERE / "outbox"
    out.mkdir(exist_ok=True)
    body, ps = out / "vehicles_without_order.html", out / "send_with_attachment.ps1"
    body.write_text(mail_html(df), encoding="utf-8")
    ps.write_text(PS_SEND, encoding="utf-8-sig")
    subject = f"Vehicles At Factory Without Order - {datetime.now(oc._tz()):%d %b %Y} ({len(df)} vehicles)" + (
        " [TEST]" if test else "")
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps), "-To", to,
                        "-Subject", subject, "-Html", str(body), "-Attach", str(OUT), "-Cc", cc], capture_output=True, text=True)
    print((r.stdout + r.stderr).strip())
    if r.returncode:
        sys.exit(r.returncode)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", help="also e-mail the report (HTML table in the body + Excel attached) to this address")
    ap.add_argument("--live", action="store_true", help="send to the scheduled To / CC list")
    ap.add_argument("--test", action="store_true", help="mark the subject [TEST]")
    ap.add_argument("--old-layout", action="store_true", help="previous layout (State column, no Remarks)")
    a = ap.parse_args()
    try:
        data = fetch(not a.old_layout)  # Remarks instead of State: approved 2026-10-12
        write(data, OUT)
    except oc.OdooError as e:
        print("ERROR:", e)
        sys.exit(1)
    print(f"{len(data)} vehicle(s) -> {OUT}")
    if a.live:
        send(data, LIVE_TO, False, LIVE_CC)
    elif a.email:
        send(data, a.email, a.test)
