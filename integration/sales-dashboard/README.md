# Integration Package — Sales Dashboard on the Lake Cement MIS

The collaborator's Odoo sales reports, hosted next to the MIS and shown in its
**Integration Package** tab (`integration-package.html`, MD / Management / Sales only).

| Report | How it appears | Data |
|---|---|---|
| Vehicles at Factory Without Order | live table + its e-mail To/CC | `vehicles_without_order.fetch()` via `web_extract.py` |
| Sales Dashboard (Streamlit `app.py`) | the full app, inside the tab, at `/sales-app/` | the app itself, pm2 `sales-app` |
| Sales vs Target – Daily Report | live table + the exact mail each salesperson gets + the matrix | `daily_report.main()` via `web_extract.py` |

**E-mails are NOT sent from this server.** They stay on the collaborator's Windows PC
(desktop Outlook + Windows Task Scheduler). The sending and scheduling scripts are not in
this repo at all (`PROVENANCE.json`). Keep those two Windows tasks enabled.

## Files

- Vendored from the package, **unchanged** — verify with `sha256sum -c integration/sales-dashboard/SHA256SUMS`
  (from the repo root). Git keeps their bytes (`.gitattributes: -text`).
- Added here: `web_extract.py` (read-only bridge), `sitecustomize_pg_ssl.py` (encrypts the Odoo
  connection), `email-schedule.json` (schedule facts), `PROVENANCE.json`, `SHA256SUMS`, this file.
- Private, never in git: `.env` (Odoo DB password), `users.toml` (Sales Dashboard logins), `.venv/`.

## Server setup (once)

1. Put `.env` (from `.env.example`; add `PG_PASSWORD`, `REFRESH_SECONDS=3600`, `PG_SSLMODE=require`)
   and the collaborator's `users.toml` in this folder.
2. As `deploy`: `bash deploy/setup-sales-app.sh`
3. With sudo: `sudo bash deploy/enable-sales-app-nginx.sh`

Restart the app: `pm2 restart sales-app`. Logs: `pm2 logs sales-app`.

## Dev PC (Windows)

```
python -m pip install --user uv
python -m uv venv --python 3.12 .venv
python -m uv pip install --python .venv\Scripts\python.exe -r requirements-lock.txt
copy sitecustomize_pg_ssl.py .venv\Lib\site-packages\lcl_pg_ssl.py
echo import lcl_pg_ssl> .venv\Lib\site-packages\lcl_pg_ssl.pth
.venv\Scripts\python.exe web_extract.py check
```

## When the collaborator sends a new package

Copy the changed files in, regenerate `SHA256SUMS`, update `PROVENANCE.json` /
`email-schedule.json` if schedules or recipients changed, and run
`npm run test:integration-static` (backend/).
