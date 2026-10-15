"""Read-only bridge: the Lake Cement MIS shows the two e-mail reports' LIVE figures by calling the
collaborator's own functions, so the web tables are the same numbers the e-mails carry. Nothing here is
reimplemented, nothing is sent, nothing is scheduled.

    .venv/bin/python web_extract.py vehicles
    .venv/bin/python web_extract.py sales-vs-target [--date YYYY-MM-DD]
    .venv/bin/python web_extract.py check

stdout carries exactly ONE JSON object (the collaborator's own prints are sent to stderr).
Exit codes: 0 ok · 2 Odoo unreachable/error · 3 Odoo not configured (.env) · 4 bad arguments · 1 anything else.

Run by backend/services/integrationExtract.js (one at a time, with a minimal environment) and by the setup
scripts' connectivity check.

What it deliberately does NOT do:
  - vehicles_without_order: never calls write() (it saves an .xlsx) or send() (Outlook). Only fetch().
  - daily_report: runs main() into a throw-away temp folder, with fetch() limited to one try (its default
    retries sleep 10 minutes three times). main() only PREPARES mails (manifest + HTML); sending is a separate
    PowerShell/Outlook step that is not vendored here at all.
  - Any attempt to start an outside program (subprocess / os.system) raises, as a second guard.
"""
import argparse
import contextlib
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXIT_OK, EXIT_ERROR, EXIT_ODOO, EXIT_NOT_CONFIGURED, EXIT_BAD_ARGS = 0, 1, 2, 3, 4


def _refuse(*_a, **_k):
    raise RuntimeError("web_extract.py must not start outside programs (no e-mail is ever sent from here)")


# Second guard against any sending path: patched before the collaborator's modules are imported.
subprocess.run = subprocess.Popen = subprocess.call = subprocess.check_call = subprocess.check_output = _refuse
os.system = _refuse
if hasattr(os, "startfile"):
    os.startfile = _refuse

from dotenv import load_dotenv  # noqa: E402

load_dotenv(HERE / ".env")

import pandas as pd  # noqa: E402

import odoo_client as oc  # noqa: E402


def _frame(df: "pd.DataFrame") -> dict:
    """DataFrame -> {columns, rows}; NaN/NaT become null, timestamps ISO (local plant time, no offset)."""
    out = json.loads(df.to_json(orient="split", date_format="iso", index=False))
    return {"columns": out["columns"], "rows": out["data"]}


def _split_addresses(s: str) -> list:
    return [a.strip() for a in str(s or "").split(";") if a.strip()]


def _file_info(p: Path) -> dict:
    """Which matrix file was used, and whether it is still the copy received in the package. A file's
    modified time is useless here (it is the git checkout / copy time), so the hash is compared instead."""
    if not p.exists():
        return {"file": p.name, "exists": False}
    digest = hashlib.sha256(p.read_bytes()).hexdigest()
    rel = p.relative_to(HERE).as_posix()
    packaged = None
    sums = HERE / "SHA256SUMS"
    if sums.exists():
        for line in sums.read_text(encoding="utf-8").splitlines():
            h, _, name = line.partition(" *")
            if name.endswith("/" + rel):
                packaged = h
    return {"file": rel, "exists": True, "sha256": digest,
            "same_as_package": (digest == packaged) if packaged else None}


def cmd_vehicles(_args) -> dict:
    import vehicles_without_order as vw
    with contextlib.redirect_stdout(sys.stderr):
        df = vw.fetch(True)  # True = Remarks layout, the live scheduled layout since 2026-10-12
    now = datetime.now(oc._tz())
    return {
        "report": "vehicles",
        "as_of": now.replace(tzinfo=None).isoformat(timespec="seconds"),
        "timezone": str(oc._tz()),
        "count": int(len(df)),
        "table": _frame(df),
        "email": {"to": _split_addresses(vw.LIVE_TO), "cc": _split_addresses(vw.LIVE_CC)},
    }


def cmd_sales_vs_target(args) -> dict:
    try:
        import daily_report as dr
    except SyntaxError as e:  # daily_report.py uses Python 3.12+ f-string syntax
        raise RuntimeError(f"daily_report.py needs Python 3.12 or newer ({e})") from None

    matrix_source = dr.MATRIX_XLSX if dr.MATRIX_XLSX.exists() else HERE / "email_master.csv"
    with contextlib.redirect_stdout(sys.stderr):
        master = dr.load_master()          # read once, from the real matrix next to this file
    original_fetch = dr.fetch
    captured = {}

    def fetch_once(d, tries=3, wait=600):  # no 10-minute retry sleeps inside a web request
        captured["result"] = original_fetch(d, tries=1, wait=0)
        return captured["result"]

    dr.load_master = lambda: master
    dr.fetch = fetch_once
    with tempfile.TemporaryDirectory(prefix="lcl-svt-") as tmp:
        dr.HERE = Path(tmp)                # main() writes its outbox/<date>/ here, then it is deleted
        argv = ["daily_report.py"] + (["--date", args.date] if args.date else [])
        saved_argv, sys.argv = sys.argv, argv
        try:
            with contextlib.redirect_stdout(sys.stderr):
                dr.main()
        finally:
            sys.argv = saved_argv
        manifest_path = Path((Path(tmp) / "outbox" / "last_manifest.txt").read_text(encoding="ascii").strip())
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for m in manifest:
            m.pop("html_file", None)       # a temp path, meaningless outside this run

    df, mf, _active = captured["result"]
    report_date = date.fromisoformat(manifest_path.parent.name)
    totals = {"sales_mt": round(float(df.sales.sum()), 2), "target_mt": round(float(df.target.sum()), 2)}
    totals["achievement_pct"] = round(totals["sales_mt"] / totals["target_mt"] * 100, 1) if totals["target_mt"] else None
    return {
        "report": "sales-vs-target",
        "report_date": report_date.isoformat(),
        "month_start": mf["start"].isoformat(),
        "day_of_month": mf.get("elapsed"),
        "days_in_month": mf.get("days"),
        "timezone": str(oc._tz()),
        "totals": totals,
        "table": _frame(df.rename(columns={"sales": "Sales (MT)", "target": "Target (MT)"})),
        "mails": manifest,                 # exactly what the 08:00 run on the PC would prepare for this date
        "matrix": {
            "source": _file_info(Path(matrix_source)),
            "rows": [{"salesperson": sp, "to": r["to"], "cc": r["cc"]} for sp, r in sorted(master.items())],
        },
        "admin_copy": dr.ADMIN_EMAIL,
    }


def cmd_check(_args) -> dict:
    """Connectivity check for the setup scripts: settings present, login works, encryption, read-only."""
    def q(con):
        version = con.run("SELECT split_part(version(), ' on ', 1)")[0][0]
        ssl_on = con.run("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")[0][0]
        writes = con.run("SELECT count(*) FROM information_schema.table_privileges WHERE grantee = current_user "
                         "AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')")[0][0]
        return {"server": version, "encrypted": bool(ssl_on), "tables_writable": int(writes)}
    out = oc._run(q)
    out["ssl_mode"] = os.getenv("PG_SSLMODE", "") or "disable"
    out["refresh_seconds"] = os.getenv("REFRESH_SECONDS", "")
    return {"report": "check", **out}


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("vehicles")
    p = sub.add_parser("sales-vs-target")
    p.add_argument("--date", help="report date YYYY-MM-DD (default: yesterday, like the 08:00 mail)")
    sub.add_parser("check")
    try:
        args = ap.parse_args()
        if getattr(args, "date", None):
            date.fromisoformat(args.date)
    except (SystemExit, ValueError):
        print(json.dumps({"ok": False, "status": "bad_arguments", "message": "unknown command or bad --date"}))
        return EXIT_BAD_ARGS

    try:
        oc._settings()
    except oc.OdooError as e:
        print(json.dumps({"ok": False, "status": "not_configured", "message": str(e)}))
        return EXIT_NOT_CONFIGURED

    handler = {"vehicles": cmd_vehicles, "sales-vs-target": cmd_sales_vs_target, "check": cmd_check}[args.cmd]
    try:
        result = handler(args)
    except oc.OdooError as e:
        print(json.dumps({"ok": False, "status": "odoo_unreachable", "message": str(e)}))
        return EXIT_ODOO
    except Exception as e:  # never a traceback on stdout; the caller reads one JSON object
        print(f"web_extract: {type(e).__name__}: {e}", file=sys.stderr)
        print(json.dumps({"ok": False, "status": "error", "message": f"{type(e).__name__}: {e}"}))
        return EXIT_ERROR
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, allow_nan=False, default=str))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
