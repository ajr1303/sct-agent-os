"""
Suburban Cyber Agent OS - Connectors service.

A small backend that stores a user's connected accounts (email first; bookings
and the Paperclip bridge reuse this same service) and talks to them securely.

Design notes:
  * Credentials are encrypted at rest with Fernet (symmetric, key in env).
  * Plaintext secrets are never logged or returned by any endpoint.
  * Every request is authorized by forwarding the caller's dashboard cookie to
    Hermes' /api/auth/me. 200 => allowed. This ties connector access to a valid
    dashboard login with no extra prompt and no second password.
  * Storage is SQLite on a mounted volume. stdlib imaplib/email/ssl do the IMAP.

This is the pattern we reuse for every future connector.
"""
import os
import ssl
import json
import sqlite3
import imaplib
import email
import datetime
from email.header import decode_header, make_header
from contextlib import closing

import httpx
from cryptography.fernet import Fernet
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

DB_PATH = os.environ.get("CONNECTORS_DB", "/data/connectors.db")
HERMES_AUTH_URL = os.environ.get("HERMES_AUTH_URL", "http://hermes:9119/api/auth/me")
_KEY = os.environ.get("CONNECTORS_KEY")
if not _KEY:
    raise RuntimeError("CONNECTORS_KEY is not set (run ./install.sh)")
fernet = Fernet(_KEY.encode() if isinstance(_KEY, str) else _KEY)

app = FastAPI(title="Agent OS Connectors", version="0.1")

# --- Provider presets -------------------------------------------------------
# Users pick a provider and we prefill IMAP host/port; "imap" is the manual
# path for any hosted domain. Google/Microsoft work here via IMAP + an app
# password today; native OAuth sign-in is a later enhancement per provider.
PRESETS = {
    "gmail":   {"label": "Google / Gmail",      "imap_host": "imap.gmail.com",         "imap_port": 993, "ssl": True,
                "hint": "Use a Google App Password (Account > Security > App passwords), not your normal password."},
    "outlook": {"label": "Microsoft 365 / Outlook", "imap_host": "outlook.office365.com", "imap_port": 993, "ssl": True,
                "hint": "If sign-in fails, create an app password or enable IMAP in your Microsoft account."},
    "yahoo":   {"label": "Yahoo Mail",          "imap_host": "imap.mail.yahoo.com",    "imap_port": 993, "ssl": True,
                "hint": "Generate an app password in Yahoo Account Security."},
    "icloud":  {"label": "iCloud Mail",         "imap_host": "imap.mail.me.com",       "imap_port": 993, "ssl": True,
                "hint": "Generate an app-specific password at appleid.apple.com."},
    "imap":    {"label": "Other (IMAP / hosted domain)", "imap_host": "", "imap_port": 993, "ssl": True,
                "hint": "Enter the IMAP host from your email provider (often mail.yourdomain.com)."},
}


# --- Storage ----------------------------------------------------------------
def get_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""
        CREATE TABLE IF NOT EXISTS mailboxes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT,
            email TEXT NOT NULL,
            provider TEXT NOT NULL,
            imap_host TEXT NOT NULL,
            imap_port INTEGER NOT NULL,
            use_ssl INTEGER NOT NULL,
            username TEXT NOT NULL,
            secret BLOB NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    return con


# --- Auth -------------------------------------------------------------------
async def require_auth(request: Request):
    cookie = request.headers.get("cookie", "")
    if not cookie:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            r = await client.get(HERMES_AUTH_URL, headers={"cookie": cookie})
    except Exception:
        raise HTTPException(status_code=503, detail="Auth check unavailable")
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return True


# --- IMAP helpers -----------------------------------------------------------
def imap_connect(host: str, port: int, use_ssl: bool, user: str, password: str):
    if use_ssl:
        ctx = ssl.create_default_context()
        M = imaplib.IMAP4_SSL(host, port, ssl_context=ctx, timeout=20)
    else:
        M = imaplib.IMAP4(host, port, timeout=20)
    M.login(user, password)
    return M


def _hdr(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


# --- Models -----------------------------------------------------------------
class MailboxIn(BaseModel):
    label: str = ""
    email: str
    provider: str = "imap"
    imap_host: str = ""
    imap_port: int = 993
    use_ssl: bool = True
    username: str = ""
    password: str


# --- Routes -----------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "service": "connectors", "version": "0.1"}


@app.get("/providers")
def providers(_auth=Depends(require_auth)):
    # Never include secrets; just the connect-form metadata.
    return {
        k: {"label": v["label"], "imap_host": v["imap_host"],
            "imap_port": v["imap_port"], "ssl": v["ssl"], "hint": v["hint"]}
        for k, v in PRESETS.items()
    }


@app.get("/mailboxes")
def list_mailboxes(_auth=Depends(require_auth)):
    with closing(get_db()) as con:
        rows = con.execute(
            "SELECT id, label, email, provider, imap_host FROM mailboxes ORDER BY id"
        ).fetchall()
    return [
        {"id": r[0], "label": r[1], "email": r[2], "provider": r[3], "imap_host": r[4]}
        for r in rows
    ]


@app.post("/mailboxes")
def add_mailbox(m: MailboxIn, _auth=Depends(require_auth)):
    preset = PRESETS.get(m.provider, PRESETS["imap"])
    host = (m.imap_host or preset["imap_host"]).strip()
    port = m.imap_port or preset["imap_port"]
    use_ssl = m.use_ssl
    user = (m.username or m.email).strip()
    if not host:
        raise HTTPException(status_code=400, detail="IMAP host is required for this provider.")
    if not m.password:
        raise HTTPException(status_code=400, detail="Password is required.")

    # Verify the login before storing anything.
    try:
        M = imap_connect(host, port, use_ssl, user, m.password)
        try:
            M.logout()
        except Exception:
            pass
    except imaplib.IMAP4.error as e:
        raise HTTPException(status_code=400, detail=f"IMAP login rejected: {str(e)[:160]}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not connect: {str(e)[:160]}")

    with closing(get_db()) as con:
        con.execute(
            """INSERT INTO mailboxes
               (label, email, provider, imap_host, imap_port, use_ssl, username, secret, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (m.label.strip() or m.email, m.email.strip(), m.provider, host, port,
             1 if use_ssl else 0, user, fernet.encrypt(m.password.encode()),
             datetime.datetime.utcnow().isoformat() + "Z"),
        )
        con.commit()
        new_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    return {"ok": True, "id": new_id}


@app.delete("/mailboxes/{mid}")
def delete_mailbox(mid: int, _auth=Depends(require_auth)):
    with closing(get_db()) as con:
        con.execute("DELETE FROM mailboxes WHERE id=?", (mid,))
        con.commit()
    return {"ok": True}


@app.get("/summary")
def summary(_auth=Depends(require_auth)):
    """Combined view across all mailboxes: unread count + latest unseen headers."""
    with closing(get_db()) as con:
        rows = con.execute(
            "SELECT id, label, email, imap_host, imap_port, use_ssl, username, secret FROM mailboxes ORDER BY id"
        ).fetchall()

    total_unread = 0
    boxes = []
    for r in rows:
        mid, label, em, host, port, use_ssl, user, secret = r
        box = {"id": mid, "label": label, "email": em, "unread": None, "messages": [], "error": None}
        try:
            password = fernet.decrypt(secret).decode()
            M = imap_connect(host, port, bool(use_ssl), user, password)
            try:
                M.select("INBOX", readonly=True)
                typ, data = M.search(None, "UNSEEN")
                ids = data[0].split() if data and data[0] else []
                box["unread"] = len(ids)
                total_unread += len(ids)
                for num in list(reversed(ids))[:5]:
                    typ, md = M.fetch(num, "(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
                    raw = b""
                    if md and md[0] and isinstance(md[0], tuple):
                        raw = md[0][1]
                    msg = email.message_from_bytes(raw)
                    box["messages"].append({
                        "from": _hdr(msg.get("From")),
                        "subject": _hdr(msg.get("Subject")) or "(no subject)",
                        "date": msg.get("Date", ""),
                    })
            finally:
                try:
                    M.logout()
                except Exception:
                    pass
        except Exception as e:
            box["error"] = str(e)[:160]
        boxes.append(box)

    return {"total_unread": total_unread, "mailbox_count": len(boxes), "mailboxes": boxes}


@app.exception_handler(HTTPException)
def _http_exc(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
