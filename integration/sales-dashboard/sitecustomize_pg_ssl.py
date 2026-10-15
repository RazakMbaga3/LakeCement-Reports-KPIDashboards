"""Encrypt the Odoo PostgreSQL connection WITHOUT editing the collaborator's odoo_client.py.

odoo_client._connect() opens every connection with pg8000.native.Connection(...) and passes no ssl_context, so
the Odoo password and all sales data would cross the internet in plain text. The Odoo server accepts TLS
(verified 2026-10-15), so this wraps that one class to add an ssl_context.

Installed into the Python venv by deploy/setup-sales-app.sh (on a dev PC: see README.md in this folder):
copied to site-packages as lcl_pg_ssl.py and loaded at interpreter start by lcl_pg_ssl.pth, so it applies to
the Streamlit app and to web_extract.py alike. The vendored files stay byte-identical (SHA256SUMS).

PG_SSLMODE is read at CONNECT time, because the modules load .env after interpreter start:
  unset / "disable"  -> unchanged (plain), exactly as the collaborator's laptop runs today
  "require"          -> TLS, certificate not checked (libpq's sslmode=require: stops eavesdropping)
  "verify-full"      -> TLS + CA chain + hostname check (needs a certificate valid for PG_HOST)
Any other value is refused rather than silently falling back to plain text.
"""
import os
import ssl

_MODES = {"", "disable", "require", "verify-full"}


def _install():
    try:
        import pg8000.native
    except Exception:  # pg8000 not installed yet (e.g. during pip install) - nothing to wrap
        return
    base = pg8000.native.Connection
    if getattr(base, "_lcl_ssl", False):
        return

    class Connection(base):
        _lcl_ssl = True

        def __init__(self, *args, **kwargs):
            mode = os.getenv("PG_SSLMODE", "").strip().lower()
            if mode not in _MODES:
                raise ValueError(f"PG_SSLMODE={mode!r} is not one of disable, require, verify-full")
            if mode in ("require", "verify-full") and kwargs.get("ssl_context") is None:
                ctx = ssl.create_default_context()
                if mode == "require":
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                kwargs["ssl_context"] = ctx
            super().__init__(*args, **kwargs)

    Connection.__name__ = Connection.__qualname__ = "Connection"
    pg8000.native.Connection = Connection


_install()
