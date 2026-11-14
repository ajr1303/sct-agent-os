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
import re
import ssl
import json
import sqlite3
import imaplib
import email
import datetime
from email.header import decode_header, make_header
from contextlib import closing
from urllib.parse import urlparse, quote
import shlex
import subprocess
import threading

import httpx
from dateutil import parser as dtparse
from cryptography.fernet import Fernet
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

DB_PATH = os.environ.get("CONNECTORS_DB", "/data/connectors.db")
HERMES_AUTH_URL = os.environ.get("HERMES_AUTH_URL", "http://hermes:9119/api/auth/me")
_KEY = os.environ.get("CONNECTORS_KEY")
if not _KEY:
    raise RuntimeError("CONNECTORS_KEY is not set (run ./install.sh)")
fernet = Fernet(_KEY.encode() if isinstance(_KEY, str) else _KEY)

# docs_url/redoc_url/openapi_url disabled: the schema and Swagger UI are reachable
# unauthenticated through the proxy and only serve to inventory the API for an
# attacker (CODE_REVIEW F-15). Nothing in the dashboard consumes them.
app = FastAPI(title="Agent OS Connectors", version="0.1",
              docs_url=None, redoc_url=None, openapi_url=None)

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
    con.execute("""
        CREATE TABLE IF NOT EXISTS bookings_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT,
            provider TEXT NOT NULL,
            secret BLOB NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS automation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            base_url TEXT NOT NULL,
            secret BLOB NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS orchestration (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            secret BLOB NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    # Per-task run-attempt ledger (Phase 2 fast-stop). Keyed by the stable
    # X-Hermes-Session-Key the Paperclip adapter sends on every run request
    # (sessionKeyStrategy "issue" -> one key per agent+task). The TLS gateway's
    # auth_request meters POST /v1/runs against this: over RUN_MAX_ATTEMPTS it
    # denies with a terminal status so a looping task halts cleanly instead of
    # burning spend. Status/events/stop calls are never metered.
    con.execute("""
        CREATE TABLE IF NOT EXISTS run_budget (
            session_key TEXT PRIMARY KEY,
            issue_key   TEXT,
            attempts    INTEGER NOT NULL DEFAULT 0,
            blocked     INTEGER NOT NULL DEFAULT 0,
            first_at    TEXT,
            last_at     TEXT,
            blocked_at  TEXT
        )
    """)
    # Workflow activations an agent has asked for. An agent can build a workflow
    # (always inactive) but can never switch one on: it files a request here and
    # the owner approves it in the Automations tab.
    con.execute("""
        CREATE TABLE IF NOT EXISTS workflow_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workflow_id   TEXT NOT NULL,
            workflow_name TEXT,
            summary       TEXT,
            requested_by  TEXT,
            status        TEXT NOT NULL DEFAULT 'pending',
            created_at    TEXT NOT NULL,
            decided_at    TEXT
        )
    """)
    # Free-form facts about the business every agent can read (name, services, tone).
    con.execute("""
        CREATE TABLE IF NOT EXISTS business_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            name TEXT, about TEXT, updated_at TEXT
        )
    """)
    # AI provider plans the owner wants usage shown for (key encrypted, never returned).
    con.execute("""
        CREATE TABLE IF NOT EXISTS usage_providers (
            provider TEXT PRIMARY KEY, secret BLOB, plan_name TEXT, monthly_price REAL, updated_at TEXT
        )
    """)
    # What each agent's own Hermes gateway reports as its model (scripts/agent-models.sh).
    con.execute("""
        CREATE TABLE IF NOT EXISTS agent_models (
            agent_id TEXT PRIMARY KEY, model TEXT, provider TEXT, hermes_version TEXT,
            ok INTEGER NOT NULL DEFAULT 0, error TEXT, checked_at TEXT
        )
    """)
    try:
        con.execute("ALTER TABLE agent_models ADD COLUMN options_json TEXT")
    except sqlite3.OperationalError:
        pass   # already there
    return con


def _agent_models():
    """agent_id -> last reported model. Empty when the collector has never run."""
    try:
        with closing(get_db()) as con:
            rows = con.execute("SELECT agent_id, model, provider, hermes_version, ok, error, checked_at "
                               "FROM agent_models").fetchall()
    except Exception:
        return {}
    return {r[0]: {"model": r[1], "provider": r[2], "hermes_version": r[3], "model_ok": bool(r[4]),
                   "model_error": r[5], "model_checked_at": r[6]} for r in rows}


def _agent_model_options(aid):
    """Providers and models this agent's machine says it can use right now."""
    try:
        with closing(get_db()) as con:
            r = con.execute("SELECT options_json FROM agent_models WHERE agent_id = ?", (aid,)).fetchone()
        opts = json.loads(r[0]) if r and r[0] else []
    except Exception:
        opts = []
    return [o for o in opts if isinstance(o, dict) and o.get("slug") and isinstance(o.get("models"), list)]


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


def imap_error_message(e):
    """Turn a raw imaplib error (often a bytes repr) into a human message."""
    raw = e.args[0] if getattr(e, "args", None) else e
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "ignore")
    raw = str(raw).strip()
    low = raw.lower()
    if "application-specific password" in low or "app password" in low or "185833" in raw:
        return ("Google rejected the password. Gmail needs an App Password, not your normal "
                "password — create one at myaccount.google.com (Security › App passwords) "
                "and paste the 16-character code.")
    if "basic authentication" in low or "basic auth" in low or "disabled" in low:
        return ("The provider blocked basic password sign-in. Enable IMAP and create an app "
                "password in your mail account, then use that code here.")
    if ("authenticationfailed" in low or "authentication failed" in low
            or "invalid credentials" in low or "login failed" in low or "auth" in low):
        return "Login failed — check the email address and password (use an app password where required)."
    raw = raw.replace("[ALERT]", "").strip()
    return "Mailbox rejected the login: " + raw[:200]


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
        raise HTTPException(status_code=400, detail=imap_error_message(e))
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


# ===========================================================================
# BOOKINGS CONNECTOR
# Users connect their booking app so agents can see upcoming appointments.
# Token/key-based providers (no OAuth redirect infra needed) plus a universal
# iCal URL path that covers Google Calendar and Microsoft/Outlook.
# ===========================================================================
BOOKING_PROVIDERS = {
    "cal_com": {
        "label": "Cal.com",
        "fields": [{"key": "api_key", "label": "API key", "type": "password", "placeholder": "cal_live_..."}],
        "hint": "Cal.com › Settings › Developer › API keys → create a key.",
    },
    "calendly": {
        "label": "Calendly",
        "fields": [{"key": "token", "label": "Personal access token", "type": "password", "placeholder": "eyJ..."}],
        "hint": "Calendly › Integrations › API & Webhooks → generate a personal access token.",
    },
    "acuity": {
        "label": "Acuity Scheduling",
        "fields": [
            {"key": "user_id", "label": "User ID", "type": "text", "placeholder": "123456"},
            {"key": "api_key", "label": "API key", "type": "password"},
        ],
        "hint": "Acuity › Integrations › API → User ID and API Key.",
    },
    "setmore": {
        "label": "Setmore",
        "fields": [{"key": "refresh_token", "label": "Refresh token", "type": "password"}],
        "hint": "Setmore › Settings › Integrations › API/Developer → generate a Refresh Token.",
    },
    "ical": {
        "label": "Google / Microsoft / iCal URL",
        "fields": [{"key": "ics_url", "label": "Secret iCal (ICS) URL", "type": "text",
                    "placeholder": "https://calendar.google.com/calendar/ical/.../basic.ics"}],
        "hint": "Google Calendar › Settings › Secret address in iCal format. Outlook › Publish calendar → ICS link.",
    },
}


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _to_dt(s):
    if s is None:
        return None
    if isinstance(s, (int, float)):
        v = float(s)
        if v > 1e12:
            v /= 1000.0
        try: return datetime.datetime.fromtimestamp(v, datetime.timezone.utc)
        except Exception: return None
    s = str(s).strip()
    if not s:
        return None
    if s.isdigit():
        v = float(s)
        if v > 1e12:
            v /= 1000.0
        try: return datetime.datetime.fromtimestamp(v, datetime.timezone.utc)
        except Exception: return None
    try:
        d = dtparse.parse(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=datetime.timezone.utc)
        return d
    except Exception:
        return None


def _upcoming(events, now, limit):
    rows = []
    for e in events:
        d = _to_dt(e.get("start"))
        if d is None:
            continue
        if d < now - datetime.timedelta(hours=2):  # keep just-started ones
            continue
        e["_dt"] = d
        rows.append(e)
    rows.sort(key=lambda x: x["_dt"])
    return [{"title": e.get("title") or "Appointment", "start": e["_dt"].isoformat(), "who": e.get("who", "")}
            for e in rows[:limit]]


def _http_get(url, **kw):
    with httpx.Client(timeout=15.0, follow_redirects=True) as c:
        return c.get(url, **kw)


def _names(attendees):
    try:
        return ", ".join([a.get("name") or a.get("email") or "" for a in (attendees or []) if a]).strip(", ")
    except Exception:
        return ""


def _raise_clean(r, name):
    """Raise on HTTP error WITHOUT the request URL or body — those can contain a
    secret (an API key, token, or the secret iCal URL carried as a query param),
    and httpx's own error string embeds the URL. Never surface that to a client."""
    if r.status_code >= 400:
        raise RuntimeError(name + " returned HTTP " + str(r.status_code))


def _scrub_secrets(text):
    """Redact any known secret value from a string before it is returned to a
    client. Upstream error bodies (e.g. Paperclip echoing the adapterConfig we
    posted) can contain the Hermes gateway key or the Paperclip board key, which
    must never leave the box in a response. Values are resolved at call time so
    this picks up the live globals and the dynamically-read board key."""
    if not text:
        return text
    secrets = [
        globals().get("HERMES_API_KEY", ""),
        globals().get("PAPERCLIP_API_KEY", ""),
        globals().get("CONNECTORS_KEY", ""),
    ]
    try:
        secrets.append(_pc_key())
    except Exception:
        pass
    for s in secrets:
        if s and len(s) >= 6 and s in text:
            text = text.replace(s, "[redacted]")
    return text


def fetch_cal_com(secret, now, limit):
    r = _http_get("https://api.cal.com/v1/bookings", params={"apiKey": secret.get("api_key", "")})
    if r.status_code in (401, 403):
        raise PermissionError("Cal.com rejected the API key.")
    _raise_clean(r, "Cal.com")
    data = r.json()
    items = data.get("bookings") or data.get("data") or []
    out = []
    for b in items:
        et = b.get("eventType") or {}
        out.append({"title": b.get("title") or et.get("title") or "Booking",
                    "start": b.get("startTime") or b.get("start"),
                    "who": _names(b.get("attendees"))})
    return _upcoming(out, now, limit)


def fetch_calendly(secret, now, limit):
    h = {"Authorization": "Bearer " + secret.get("token", "")}
    me = _http_get("https://api.calendly.com/users/me", headers=h)
    if me.status_code in (401, 403):
        raise PermissionError("Calendly rejected the personal access token.")
    _raise_clean(me, "Calendly")
    uri = (me.json().get("resource") or {}).get("uri")
    params = {"user": uri, "sort": "start_time:asc", "count": str(max(limit, 10)),
              "min_start_time": now.strftime("%Y-%m-%dT%H:%M:%SZ")}
    r = _http_get("https://api.calendly.com/scheduled_events", headers=h, params=params)
    _raise_clean(r, "Calendly")
    out = []
    for ev in r.json().get("collection", []):
        out.append({"title": ev.get("name") or "Event", "start": ev.get("start_time"), "who": ""})
    return _upcoming(out, now, limit)


def fetch_acuity(secret, now, limit):
    r = _http_get("https://acuityscheduling.com/api/v1/appointments",
                  params={"max": str(max(limit, 15)), "minDate": now.strftime("%Y-%m-%d")},
                  auth=(secret.get("user_id", ""), secret.get("api_key", "")))
    if r.status_code in (401, 403):
        raise PermissionError("Acuity rejected the User ID / API key.")
    _raise_clean(r, "Acuity")
    out = []
    for a in (r.json() or []):
        who = (str(a.get("firstName", "")) + " " + str(a.get("lastName", ""))).strip()
        out.append({"title": a.get("type") or "Appointment", "start": a.get("datetime"), "who": who})
    return _upcoming(out, now, limit)


_setmore_cache = {}


def _setmore_token(rt):
    import time
    c = _setmore_cache.get(rt)
    if c and c[1] > time.time() + 60:
        return c[0]
    r = _http_get("https://developer.setmore.com/api/v1/o/oauth2/token", params={"refreshToken": rt})
    if r.status_code in (401, 403):
        raise PermissionError("Setmore rejected the refresh token.")
    _raise_clean(r, "Setmore")
    tok = ((r.json().get("data") or {}).get("token") or {})
    at = tok.get("access_token")
    if not at:
        raise PermissionError("Setmore did not return an access token for that refresh token.")
    _setmore_cache[rt] = (at, time.time() + float(tok.get("expires_in") or 3600))
    return at


def fetch_setmore(secret, now, limit):
    at = _setmore_token(secret.get("refresh_token", ""))
    h = {"Authorization": "Bearer " + at}
    params = {"startDate": now.strftime("%d/%m/%Y"),
              "endDate": (now + datetime.timedelta(days=45)).strftime("%d/%m/%Y")}
    r = _http_get("https://developer.setmore.com/api/v1/bookings/appointments", headers=h, params=params)
    _raise_clean(r, "Setmore")
    data = r.json().get("data") or {}
    appts = data.get("appointments") or data.get("appointment") or []
    out = []
    for a in appts:
        out.append({"title": a.get("label") or a.get("service_name") or "Appointment",
                    "start": a.get("start_time") or a.get("startTime"),
                    "who": a.get("customer_name") or a.get("customer_label") or ""})
    return _upcoming(out, now, limit)


def fetch_ical(secret, now, limit):
    url = secret.get("ics_url", "")
    if not url.lower().startswith("http"):
        raise ValueError("Enter the full https URL of the iCal (ICS) feed.")
    r = _http_get(url)
    if r.status_code in (401, 403):
        raise PermissionError("That calendar URL needs authentication — use the secret/private iCal address.")
    _raise_clean(r, "The calendar feed")
    text = r.text
    if "BEGIN:VCALENDAR" not in text:
        raise ValueError("That URL did not return an iCal (ICS) feed.")
    from icalendar import Calendar
    cal = Calendar.from_ical(text)
    out = []
    for comp in cal.walk("VEVENT"):
        ds = comp.get("DTSTART")
        if not ds:
            continue
        d = ds.dt
        if isinstance(d, datetime.datetime):
            if d.tzinfo is None:
                d = d.replace(tzinfo=datetime.timezone.utc)
        else:
            d = datetime.datetime(d.year, d.month, d.day, tzinfo=datetime.timezone.utc)
        out.append({"title": str(comp.get("SUMMARY") or "Event"), "start": d.isoformat(), "who": ""})
    return _upcoming(out, now, limit)


BOOKING_FETCH = {
    "cal_com": fetch_cal_com, "calendly": fetch_calendly, "acuity": fetch_acuity,
    "setmore": fetch_setmore, "ical": fetch_ical,
}


class BookingIn(BaseModel):
    label: str = ""
    provider: str
    fields: dict = {}


@app.get("/bookings/providers")
def booking_providers(_auth=Depends(require_auth)):
    return BOOKING_PROVIDERS


@app.get("/bookings/accounts")
def list_bookings(_auth=Depends(require_auth)):
    with closing(get_db()) as con:
        rows = con.execute("SELECT id, label, provider FROM bookings_accounts ORDER BY id").fetchall()
    return [{"id": r[0], "label": r[1], "provider": r[2],
             "provider_label": (BOOKING_PROVIDERS.get(r[2]) or {}).get("label", r[2])} for r in rows]


@app.post("/bookings/accounts")
def add_booking(b: BookingIn, _auth=Depends(require_auth)):
    meta = BOOKING_PROVIDERS.get(b.provider)
    if not meta or b.provider not in BOOKING_FETCH:
        raise HTTPException(status_code=400, detail="Unknown booking provider.")
    secret = b.fields or {}
    for f in meta["fields"]:
        if not str(secret.get(f["key"], "")).strip():
            raise HTTPException(status_code=400, detail=f["label"] + " is required.")
    now = _now()
    try:
        BOOKING_FETCH[b.provider](secret, now, 1)  # live validation
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail="Could not connect: " + str(e)[:160])
    with closing(get_db()) as con:
        con.execute("INSERT INTO bookings_accounts (label, provider, secret, created_at) VALUES (?,?,?,?)",
                    (b.label.strip() or meta["label"], b.provider,
                     fernet.encrypt(json.dumps(secret).encode()), now.isoformat()))
        con.commit()
        nid = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    return {"ok": True, "id": nid}


@app.delete("/bookings/accounts/{bid}")
def del_booking(bid: int, _auth=Depends(require_auth)):
    with closing(get_db()) as con:
        con.execute("DELETE FROM bookings_accounts WHERE id=?", (bid,))
        con.commit()
    return {"ok": True}


@app.get("/bookings/summary")
def bookings_summary(_auth=Depends(require_auth)):
    now = _now()
    with closing(get_db()) as con:
        rows = con.execute("SELECT id, label, provider, secret FROM bookings_accounts ORDER BY id").fetchall()
    accounts = []
    combined = []
    for r in rows:
        bid, label, provider, secret = r
        acc = {"id": bid, "label": label, "provider": provider,
               "provider_label": (BOOKING_PROVIDERS.get(provider) or {}).get("label", provider),
               "upcoming": [], "error": None}
        try:
            sec = json.loads(fernet.decrypt(secret).decode())
            evs = BOOKING_FETCH[provider](sec, now, 5)
            acc["upcoming"] = evs
            for e in evs:
                combined.append(dict(e, account=label))
        except PermissionError as e:
            acc["error"] = str(e)
        except Exception as e:
            acc["error"] = str(e)[:160]
        accounts.append(acc)
    combined.sort(key=lambda x: x["start"])
    return {"account_count": len(accounts), "accounts": accounts, "next": combined[:8]}


# ===========================================================================
# AUTOMATIONS (bundled n8n)
# The dashboard reads workflow/run status through n8n's public API. The API key
# is stored encrypted here; n8n is reached internally (never exposed to browser).
# ===========================================================================
N8N_INTERNAL_URL = os.environ.get("N8N_INTERNAL_URL", "http://n8n:5678").rstrip("/")


def _n8n_up():
    try:
        return _http_get(N8N_INTERNAL_URL + "/healthz").status_code == 200
    except Exception:
        return False


def _n8n_conn():
    with closing(get_db()) as con:
        row = con.execute("SELECT base_url, secret FROM automation ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        return None
    return {"base_url": row[0].rstrip("/"), "api_key": fernet.decrypt(row[1]).decode()}


def _n8n_api(path, params=None):
    conn = _n8n_conn()
    if not conn:
        raise PermissionError("No n8n API key connected yet.")
    r = _http_get(conn["base_url"] + path, headers={"X-N8N-API-KEY": conn["api_key"]}, params=params or {})
    if r.status_code in (401, 403):
        raise PermissionError("n8n rejected the stored API key.")
    r.raise_for_status()
    return r.json()


class N8nConnect(BaseModel):
    api_key: str


@app.get("/automations/status")
def automations_status(_auth=Depends(require_auth)):
    try:
        connected = bool(_n8n_conn())
    except Exception:
        connected = False
    return {"n8n_up": _n8n_up(), "connected": connected}


@app.post("/automations/connect")
def automations_connect(c: N8nConnect, _auth=Depends(require_auth)):
    key = (c.api_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Enter the n8n API key.")
    try:
        r = _http_get(N8N_INTERNAL_URL + "/api/v1/workflows",
                      headers={"X-N8N-API-KEY": key}, params={"limit": 1})
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach n8n: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="n8n rejected that API key. Copy it from n8n › Settings › n8n API.")
    try:
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=400, detail="n8n returned an error: " + str(e)[:140])
    with closing(get_db()) as con:
        con.execute("DELETE FROM automation")
        con.execute("INSERT INTO automation (base_url, secret, created_at) VALUES (?,?,?)",
                    (N8N_INTERNAL_URL, fernet.encrypt(key.encode()), _now().isoformat()))
        con.commit()
    return {"ok": True}


@app.delete("/automations/connection")
def automations_disconnect(_auth=Depends(require_auth)):
    with closing(get_db()) as con:
        con.execute("DELETE FROM automation")
        con.commit()
    return {"ok": True}


@app.get("/automations/workflows")
def automations_workflows(_auth=Depends(require_auth)):
    wfs, cursor = [], None
    try:
        for _ in range(8):  # n8n pages at most 250 at a time
            params = {"limit": 250}
            if cursor:
                params["cursor"] = cursor
            data = _n8n_api("/api/v1/workflows", params=params)
            wfs.extend(data.get("data") or [])
            cursor = data.get("nextCursor")
            if not cursor:
                break
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach n8n: " + str(e)[:140])
    out = [{"id": w.get("id"), "name": w.get("name") or "Workflow", "active": bool(w.get("active")),
            "archived": bool(w.get("isArchived"))} for w in wfs]
    out.sort(key=lambda w: (not w["active"], w["archived"], w["name"].lower()))
    return {"count": len(out), "active": sum(1 for w in out if w["active"]), "workflows": out}


def _set_workflow_active(wid, on):
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", str(wid)):
        raise HTTPException(status_code=400, detail="Bad workflow id.")
    conn = _n8n_conn()
    if not conn:
        raise HTTPException(status_code=400, detail="No n8n API key connected yet.")
    try:
        with httpx.Client(timeout=30.0) as c:
            r = c.post(conn["base_url"] + "/api/v1/workflows/" + str(wid) + ("/activate" if on else "/deactivate"),
                       headers={"X-N8N-API-KEY": conn["api_key"]}, json={})
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach n8n: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="n8n rejected the stored API key. Reconnect it below.")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="n8n no longer has that workflow.")
    if r.status_code >= 400:
        try:
            msg = (r.json() or {}).get("message") or r.text
        except Exception:
            msg = r.text
        # n8n explains why (no trigger step, missing credential, retired step...).
        raise HTTPException(status_code=400, detail="n8n would not " + ("turn it on" if on else "turn it off")
                            + ": " + _scrub_secrets(str(msg))[:300])
    return {"ok": True, "id": str(wid), "active": bool(on)}


@app.post("/automations/workflows/{wid}/activate")
def activate_workflow(wid: str, _auth=Depends(require_auth)):
    """Owner action from the dashboard. Agents have no equivalent tool."""
    return _set_workflow_active(wid, True)


@app.post("/automations/workflows/{wid}/deactivate")
def deactivate_workflow(wid: str, _auth=Depends(require_auth)):
    return _set_workflow_active(wid, False)


@app.get("/automations/executions")
def automations_executions(_auth=Depends(require_auth)):
    try:
        wfdata = _n8n_api("/api/v1/workflows", params={"limit": 100})
        exdata = _n8n_api("/api/v1/executions", params={"limit": 15})
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach n8n: " + str(e)[:140])
    names = {}
    for w in (wfdata.get("data") or []):
        names[str(w.get("id"))] = w.get("name")
    out = []
    for ex in (exdata.get("data") or []):
        out.append({
            "id": ex.get("id"),
            "workflow": names.get(str(ex.get("workflowId"))) or "Workflow",
            "status": ex.get("status") or ("success" if ex.get("finished") else "running"),
            "started": ex.get("startedAt"),
        })
    return {"executions": out}


# ===========================================================================
# ORCHESTRATION (Paperclip) — READ-ONLY
# The dashboard surfaces Paperclip's managed agents and "waiting on you" items.
# This bridge is intentionally GET-only: no writes, approvals, or agent actions,
# which keeps the connect-to-existing path safe to point at a live instance.
# Bundled Paperclip runs local_trusted (no key). External instances pass a board
# API key via Authorization: Bearer.
# ===========================================================================
PAPERCLIP_URL = os.environ.get("PAPERCLIP_URL", "http://paperclip:3100").rstrip("/")
PAPERCLIP_API_KEY = os.environ.get("PAPERCLIP_API_KEY", "").strip()
PAPERCLIP_COMPANY_ID = os.environ.get("PAPERCLIP_COMPANY_ID", "").strip()
HERMES_API_URL = os.environ.get("HERMES_API_URL", "http://hermes:8642").rstrip("/")
# The HTTPS endpoint Paperclip agents talk to. Paperclip refuses to run an agent
# that reaches a non-loopback host over plain HTTP, so agents must point at the
# TLS-terminated gateway (proxy alias hermes-gateway), not http://hermes:8642.
HERMES_GATEWAY_URL = os.environ.get("HERMES_GATEWAY_URL", "https://hermes-gateway:8443").rstrip("/")
HERMES_API_KEY = os.environ.get("HERMES_API_KEY", "").strip()

# Spend guardrails — Paperclip's native budget hard-stop. When monthly spend
# reaches the cap, Paperclip auto-pauses the agent/company ("budget hard-stop
# reached"), so a runaway loop can never blow past a hard dollar ceiling. The
# company cap is the catastrophe backstop; the per-agent cap is off by default
# so legit agents aren't surprised. Cents; 0 disables. Env-overridable per client.
def _env_int(name, default):
    try:
        return max(0, int(os.environ.get(name, "").strip() or default))
    except Exception:
        return default
# Off by default. Paperclip's hard-stop fails CLOSED on usage it can't price, and
# Hermes-gateway runs report tokens but usually no dollar cost — so a cap here
# pauses the whole company on the first run while showing $0 spent, yet can't
# see real spend. Real protection: the gateway run fast-stop (RUN_MAX_ATTEMPTS)
# plus a hard spend limit at the LLM provider. Set this only for models whose
# runs report cost to Paperclip.
COMPANY_BUDGET_CENTS = _env_int("COMPANY_BUDGET_CENTS", 0)
AGENT_BUDGET_CENTS = _env_int("AGENT_BUDGET_CENTS", 0)          # off; company cap is the ceiling

# Per-task fast-stop (Phase 2). Max run-creations allowed for one agent+task
# (keyed by the stable session key) before the gateway halts it. This trips in
# seconds on a tight retry loop — long before the monthly dollar cap above would
# — and is the thing that actually caps a single runaway task. 0 disables.
RUN_MAX_ATTEMPTS = _env_int("RUN_MAX_ATTEMPTS", 6)


def _pc_stored_key():
    with closing(get_db()) as con:
        row = con.execute("SELECT secret FROM orchestration ORDER BY id DESC LIMIT 1").fetchone()
    if row:
        try:
            return fernet.decrypt(row[0]).decode()
        except Exception:
            return None
    return None


def _pc_key():
    return _pc_stored_key() or PAPERCLIP_API_KEY or ""


def _pc_headers():
    key = _pc_key()
    return {"Authorization": "Bearer " + key} if key else {}


def _pc_get(path):
    r = _http_get(PAPERCLIP_URL + path, headers=_pc_headers())
    if r.status_code in (401, 403):
        raise PermissionError("Paperclip rejected the request (auth).")
    r.raise_for_status()
    return r.json()


def _pc_up():
    try:
        return _http_get(PAPERCLIP_URL + "/api/health").status_code == 200
    except Exception:
        return False


def _pc_mode():
    return "external" if (PAPERCLIP_API_KEY or PAPERCLIP_URL != "http://paperclip:3100") else "bundled"


def _pc_company_id():
    if PAPERCLIP_COMPANY_ID:
        return PAPERCLIP_COMPANY_ID
    data = _pc_get("/api/companies")
    items = data.get("companies") if isinstance(data, dict) else None
    if items is None:
        items = data.get("data") if isinstance(data, dict) else None
    if items is None:
        items = data if isinstance(data, list) else []
    if items:
        c = items[0]
        return c.get("id") or c.get("companyId")
    return None


class PcConnect(BaseModel):
    api_key: str


@app.get("/orchestration/status")
def orchestration_status(_auth=Depends(require_auth)):
    return {"paperclip_up": _pc_up(), "mode": _pc_mode(), "connected": bool(_pc_key())}


@app.post("/orchestration/connect")
def orchestration_connect(c: PcConnect, _auth=Depends(require_auth)):
    key = (c.api_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="Enter the Paperclip board API key.")
    try:
        r = _http_get(PAPERCLIP_URL + "/api/companies", headers={"Authorization": "Bearer " + key})
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Paperclip rejected that board API key. On the server, run: sudo ./scripts/paperclip-connect.sh")
    try:
        r.raise_for_status()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Paperclip returned an error: " + str(e)[:140])
    with closing(get_db()) as con:
        con.execute("DELETE FROM orchestration")
        con.execute("INSERT INTO orchestration (secret, created_at) VALUES (?,?)",
                    (fernet.encrypt(key.encode()), _now().isoformat()))
        con.commit()
    return {"ok": True}


@app.delete("/orchestration/connection")
def orchestration_disconnect(_auth=Depends(require_auth)):
    with closing(get_db()) as con:
        con.execute("DELETE FROM orchestration")
        con.commit()
    return {"ok": True}


AGENT_ROLES = {"ceo", "cto", "cmo", "cfo", "security", "engineer",
               "designer", "pm", "qa", "devops", "researcher", "general"}


# Appended to every agent's instructions so a finished task gets closed instead of
# being re-run by Paperclip's recovery. Stripped again when the dashboard reads the
# instructions back for editing.
AGENT_FOOTER_MARK = "--- Agent OS working rules ---"
AGENT_FOOTER = (AGENT_FOOTER_MARK + "\n"
    "- When you finish a task: post your result as a reply on the task, then call the "
    "complete_task tool (agent_os) with the task id, your Agent ID and a one-line summary. "
    "A task is not finished until you do.\n"
    "- If you cannot finish without the owner (a decision, a login, missing information): "
    "call need_owner_input with a clear question, then stop. Do not guess.\n"
    "- If you need the business's name, services or tone, call get_business_profile. "
    "Never write placeholders like [Company Name].\n"
    "- You work on the task you were given. Do not assign tasks to other agents.")


def _strip_footer(text):
    return (text or "").split(AGENT_FOOTER_MARK, 1)[0].rstrip()


def _with_footer(text):
    base = _strip_footer(text)
    return (base + "\n\n" if base else "") + AGENT_FOOTER


class AgentCreate(BaseModel):
    name: str
    instructions: str = ""
    role: str = "general"


@app.post("/orchestration/agents")
def create_agent(a: AgentCreate, _auth=Depends(require_auth)):
    """Unified create: register a Paperclip-managed agent that runs on our Hermes
    gateway (adapterType=hermes_gateway). One action wires orchestration + runtime."""
    name = (a.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Agent name is required.")
    key = _pc_key()
    if not key:
        raise HTTPException(status_code=400, detail="Connect Paperclip first (board API key).")
    if not HERMES_API_KEY:
        raise HTTPException(status_code=500, detail="HERMES_API_KEY is not configured on the connectors service.")
    try:
        cid = _pc_company_id()
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if not cid:
        raise HTTPException(status_code=400, detail="No Paperclip company found yet.")

    # Is this the company's first agent? If so, we seed a one-time welcome task
    # after creating it, so a fresh install immediately shows a real agent run.
    is_first_agent = False
    try:
        existing = _pc_get("/api/companies/" + str(cid) + "/agents")
        existing_items = existing if isinstance(existing, list) else (existing.get("agents") or existing.get("data") or [])
        is_first_agent = len(existing_items) == 0
    except Exception:
        is_first_agent = False

    adapter_config = {
        # HTTPS gateway (TLS terminated by the proxy, Paperclip trusts our CA). This
        # passes Paperclip's non-loopback safety check, so no insecure escape hatch.
        "apiBaseUrl": HERMES_GATEWAY_URL,
        "apiKey": HERMES_API_KEY,
        "sessionKeyStrategy": "issue",
    }
    adapter_config["instructions"] = _with_footer(a.instructions)
    role = (a.role or "general").strip().lower()
    if role not in AGENT_ROLES:
        role = "general"
    body = {"name": name, "role": role, "adapterType": "hermes_gateway", "adapterConfig": adapter_config}
    if AGENT_BUDGET_CENTS > 0:
        body["budgetMonthlyCents"] = AGENT_BUDGET_CENTS  # per-agent monthly hard-stop

    # Make sure the company-wide monthly ceiling is set before any agent can run.
    # Idempotent (only sets when unset), so it's safe to call on every create and
    # also backfills existing installs. This is the backstop that caps total spend.
    _ensure_company_budget(cid)

    try:
        with httpx.Client(timeout=45.0, follow_redirects=True) as c:
            r = c.post(PAPERCLIP_URL + "/api/companies/" + str(cid) + "/agents",
                       headers={"Authorization": "Bearer " + key}, json=body)
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Paperclip rejected the request (auth).")
    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail="Paperclip could not create the agent: " + _scrub_secrets(r.text)[:240])
    try:
        data = r.json()
    except Exception:
        data = {}
    new_id = data.get("id")
    seeded = False
    if is_first_agent and new_id:
        seeded = _seed_welcome_task(cid, new_id)
    return {"ok": True, "agent": {"id": new_id, "name": data.get("name") or name}, "welcome_seeded": seeded}


def _ensure_company_budget(cid):
    """Set the company-wide monthly budget hard-stop to our default, but only if the
    owner hasn't already set one — never clobber a value they chose. Paperclip
    auto-pauses the company when this cap is reached, so spend can't run away.
    Best-effort: never blocks agent creation."""
    if COMPANY_BUDGET_CENTS <= 0:
        return
    try:
        ov = _pc_get("/api/companies/" + str(cid) + "/budgets/overview")
    except Exception:
        ov = None
    # The overview returns policies[]; a company-scope active policy with amount>0
    # means the owner already has a budget. Never overwrite it.
    if isinstance(ov, dict) and isinstance(ov.get("policies"), list):
        for p in ov["policies"]:
            if (isinstance(p, dict) and p.get("scopeType") == "company"
                    and p.get("isActive") and isinstance(p.get("amount"), (int, float)) and p.get("amount") > 0):
                return
    try:
        with httpx.Client(timeout=20.0, follow_redirects=True) as c:
            c.request("PATCH", PAPERCLIP_URL + "/api/companies/" + str(cid) + "/budgets",
                      headers=_pc_headers(), json={"budgetMonthlyCents": COMPANY_BUDGET_CENTS})
    except Exception:
        pass


WELCOME_TITLE = "Welcome — meet your agent"

def _company_name(cid):
    """Best-effort company display name for the welcome message."""
    try:
        data = _pc_get("/api/companies")
        items = data if isinstance(data, list) else (data.get("companies") or data.get("data") or [])
        for c in items:
            if (c.get("id") or c.get("companyId")) == cid:
                return c.get("name") or c.get("displayName") or "your team"
    except Exception:
        pass
    return "your team"


def _seed_welcome_task(cid, agent_id):
    """Create a one-time orientation task for the first agent so a fresh install
    shows a real agent run immediately. Best-effort: never fails agent creation."""
    company = _company_name(cid)
    desc = ("Introduce yourself to the owner of " + company + ". In one short, warm paragraph, "
            "explain what you can help with here. Then list three specific things you could start "
            "on this week. Post it as your reply on this task.")
    body = {"title": WELCOME_TITLE, "description": desc, "assigneeAgentId": agent_id, "priority": "medium"}
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as c:
            r = c.post(PAPERCLIP_URL + "/api/companies/" + str(cid) + "/issues",
                       headers=_pc_headers(), json=body)
        return r.status_code < 400
    except Exception:
        return False


@app.delete("/orchestration/agents/{aid}")
def delete_agent(aid: str, _auth=Depends(require_auth)):
    key = _pc_key()
    if not key:
        raise HTTPException(status_code=400, detail="Connect Paperclip first (board API key).")
    headers = {"Authorization": "Bearer " + key}
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as c:
            # Paperclip requires an agent to be terminated before it can be deleted.
            try:
                c.post(PAPERCLIP_URL + "/api/agents/" + aid + "/terminate", headers=headers)
            except Exception:
                pass
            r = c.request("DELETE", PAPERCLIP_URL + "/api/agents/" + aid, headers=headers)
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Paperclip rejected the request (auth).")
    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail="Paperclip could not delete the agent: " + _scrub_secrets(r.text)[:200])
    return {"ok": True}


@app.get("/orchestration/agents/{aid}")
def get_agent(aid: str, _auth=Depends(require_auth)):
    """Fetch one agent's editable fields (name, role, instructions) so the
    dashboard can pre-fill the Edit form. Instructions live on the Paperclip
    agent's adapterConfig; they are not a secret so Paperclip returns them."""
    key = _pc_key()
    if not key:
        raise HTTPException(status_code=400, detail="Connect Paperclip first (board API key).")
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as c:
            r = c.get(PAPERCLIP_URL + "/api/agents/" + aid,
                      headers={"Authorization": "Bearer " + key})
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Paperclip rejected the request (auth).")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Agent not found.")
    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail="Paperclip could not read the agent: " + _scrub_secrets(r.text)[:200])
    try:
        d = r.json()
    except Exception:
        d = {}
    ac = d.get("adapterConfig") or {}
    return {
        "id": d.get("id") or aid,
        "name": d.get("name"),
        "role": d.get("role") or "general",
        "instructions": _strip_footer((ac.get("instructions") if isinstance(ac, dict) else "") or ""),
        "status": d.get("status"),
        "pauseReason": d.get("pauseReason"),
    }


class AgentUpdate(BaseModel):
    instructions: str | None = None
    role: str | None = None


@app.put("/orchestration/agents/{aid}")
def update_agent(aid: str, a: AgentUpdate, _auth=Depends(require_auth)):
    """Edit an existing agent's role and/or instructions. Paperclip PATCH merges
    adapterConfig (no replaceAdapterConfig flag), so sending only {instructions}
    preserves the gateway apiBaseUrl/apiKey/flags. Name is intentionally not
    editable here — it is the key that links this agent to its Hermes profile."""
    key = _pc_key()
    if not key:
        raise HTTPException(status_code=400, detail="Connect Paperclip first (board API key).")
    body = {}
    if a.role is not None:
        role = a.role.strip().lower()
        if role not in AGENT_ROLES:
            role = "general"
        body["role"] = role
    if a.instructions is not None:
        # Merge-only patch: just the instructions key goes into adapterConfig.
        body["adapterConfig"] = {"instructions": _with_footer(a.instructions)}
    if not body:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    try:
        with httpx.Client(timeout=45.0, follow_redirects=True) as c:
            r = c.request("PATCH", PAPERCLIP_URL + "/api/agents/" + aid,
                          headers={"Authorization": "Bearer " + key}, json=body)
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Paperclip rejected the request (auth).")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Agent not found.")
    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail="Paperclip could not update the agent: " + _scrub_secrets(r.text)[:240])
    return {"ok": True}


# --- Agents page: every Paperclip agent, with the fields the owner edits ------

def _agent_host(ac):
    """Where an agent's gateway lives, for display. Local = this box's own Hermes."""
    url = str((ac or {}).get("apiBaseUrl") or (ac or {}).get("url") or "")
    host = ""
    try:
        host = (urlparse(url).hostname or "") if url else ""
    except Exception:
        host = ""
    local = (not host) or ("." not in host) or host in ("localhost", "127.0.0.1")
    return host, local


def _agent_row(a):
    ac = a.get("adapterConfig") if isinstance(a.get("adapterConfig"), dict) else {}
    host, local = _agent_host(ac)
    return {"id": a.get("id"), "name": a.get("name") or "Agent", "title": a.get("title"),
            "role": a.get("role") or "general", "status": a.get("status"),
            "pause_reason": a.get("pauseReason"), "reports_to": a.get("reportsTo"),
            "capabilities": a.get("capabilities"), "adapter": a.get("adapterType"),
            "runs_on": "This server" if local else host, "local": local,
            "last_active": a.get("lastHeartbeatAt"), "url_key": a.get("urlKey")}


def _agent_instructions(aid, ac):
    """Instructions as the owner sees them in Paperclip: the agent's entry
    instruction file when it has one, else the inline text our own agents use."""
    try:
        b = _pc_get("/api/agents/" + aid + "/instructions-bundle")
        entry = b.get("entryFile") if isinstance(b, dict) else None
        files = [f.get("path") for f in (b.get("files") or []) if isinstance(f, dict)] if isinstance(b, dict) else []
        if entry and entry in files:
            f = _pc_get("/api/agents/" + aid + "/instructions-bundle/file?path=" + quote(entry, safe=""))
            if isinstance(f, dict) and isinstance(f.get("content"), str):
                return {"source": "file", "path": entry, "hash": f.get("contentHash"),
                        "text": f["content"][:200000], "other_files": max(0, len(files) - 1)}
    except Exception:
        pass
    inline = ac.get("instructions") if isinstance(ac, dict) else None
    if isinstance(inline, str) and inline.strip():
        return {"source": "inline", "path": None, "hash": None, "text": _strip_footer(inline), "other_files": 0}
    return {"source": None, "path": None, "hash": None, "text": "", "other_files": 0}


@app.get("/orchestration/team")
def team_list(_auth=Depends(require_auth)):
    if not _pc_up():
        return {"paperclip_up": False, "agents": [], "can_edit": False}
    try:
        cid = _pc_company_id()
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if not cid:
        return {"paperclip_up": True, "agents": [], "can_edit": False}
    ag = _pc_get("/api/companies/" + str(cid) + "/agents")
    items = ag if isinstance(ag, list) else (ag.get("agents") or ag.get("data") or [])
    rows = [_agent_row(a) for a in items if isinstance(a, dict) and str(a.get("status")) != "terminated"]
    models = _agent_models()
    for r in rows:
        r.update(models.get(str(r["id"])) or {"model": None, "provider": None, "hermes_version": None,
                                              "model_ok": False, "model_error": None, "model_checked_at": None})
    rows.sort(key=lambda r: str(r["name"]).lower())
    return {"paperclip_up": True, "company_id": cid, "agents": rows[:200], "can_edit": _pc_mode() != "external"}


@app.get("/orchestration/team/{aid}")
def team_get(aid: str, _auth=Depends(require_auth)):
    aid = _safe_id(aid)
    d = _pc_send("GET", "/api/agents/" + aid, what="read the agent")
    row = _agent_row(d if isinstance(d, dict) else {})
    row["instructions"] = _agent_instructions(aid, d.get("adapterConfig") if isinstance(d, dict) else {})
    row["can_edit"] = _pc_mode() != "external"
    row.update(_agent_models().get(str(row["id"])) or {"model": None, "provider": None, "hermes_version": None,
                                                         "model_ok": False, "model_error": None, "model_checked_at": None})
    return row


class TeamUpdate(BaseModel):
    name: str | None = None
    title: str | None = None
    role: str | None = None
    reports_to: str | None = None        # "" clears the manager
    capabilities: str | None = None
    instructions: str | None = None
    instructions_hash: str | None = None  # what the editor loaded; Paperclip refuses a stale save


@app.put("/orchestration/team/{aid}")
def team_update(aid: str, u: TeamUpdate, _auth=Depends(require_auth)):
    """Edit an agent the way its Paperclip page does: name, title, role, manager,
    description and instructions. Gateway address, keys and budgets stay in Paperclip."""
    _task_writable()
    aid = _safe_id(aid)
    cur = _pc_send("GET", "/api/agents/" + aid, what="read the agent")
    ac = cur.get("adapterConfig") if isinstance(cur.get("adapterConfig"), dict) else {}
    _, local = _agent_host(ac)
    body = {}
    if u.name is not None and u.name.strip() != str(cur.get("name") or ""):
        if local:
            raise HTTPException(status_code=400, detail="This agent runs on this server and its name is tied to "
                                "its Hermes profile, so it can't be renamed here. Create a new agent instead.")
        nm = u.name.strip()
        if not nm or len(nm) > 80:
            raise HTTPException(status_code=400, detail="Name must be 1 to 80 characters.")
        body["name"] = nm
    if u.title is not None:
        body["title"] = u.title.strip()[:120] or None
    if u.role is not None:
        role = u.role.strip().lower()
        body["role"] = role if role in AGENT_ROLES else "general"
    if u.reports_to is not None:
        rt = u.reports_to.strip()
        if rt:
            rt = _safe_id(rt)
            if rt == aid:
                raise HTTPException(status_code=400, detail="An agent can't report to itself.")
        body["reportsTo"] = rt or None
    if u.capabilities is not None:
        body["capabilities"] = u.capabilities.strip()[:4000] or None
    done = []
    if u.instructions is not None:
        info = _agent_instructions(aid, ac)
        if u.instructions.strip() != (info["text"] or "").strip():
            if info["source"] == "file":
                _pc_send("PUT", "/api/agents/" + aid + "/instructions-bundle/file",
                         {"path": info["path"], "content": u.instructions,
                          "baseHash": u.instructions_hash or info["hash"]}, what="save the instructions")
                done.append("instructions")
            else:
                body["adapterConfig"] = {"instructions": _with_footer(u.instructions)}
    if body:
        _pc_send("PATCH", "/api/agents/" + aid, body, what="update the agent")
        done.extend(k for k in body if k != "adapterConfig")
        if "adapterConfig" in body:
            done.append("instructions")
    if not done:
        return {"ok": True, "changed": []}
    return {"ok": True, "changed": done}


# --- Changing an agent's model on its own machine (over SSH) ------------------
# The box may hold an SSH key for agent machines (scripts/agent-ssh.sh). A model
# change edits that machine's Hermes config with Hermes' own command, restarts its
# gateway, checks the gateway reports the new model, and restores the previous
# config if it does not. Only choices the machine itself listed are accepted.

AGENT_SSH_DIR = os.environ.get("AGENT_SSH_DIR", "/agent-ssh")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$")
_MODEL_JOBS = {}          # agent id -> {"state", "message", "at"}
_MODEL_JOBS_LOCK = threading.Lock()

_REMOTE_SET_MODEL = r"""
set -u
MODEL="$1"; PROVIDER="$2"; SVC="$3"; SCOPE="$4"
H=$(command -v hermes 2>/dev/null || true); [ -x "$H" ] || H="$HOME/.local/bin/hermes"
[ -x "$H" ] || { echo "ERR The hermes command was not found on that machine."; exit 10; }
CFG="$HOME/.hermes/config.yaml"; ENVF="$HOME/.hermes/.env"; BAK="$CFG.bak-agent-os"
val() { awk -F= -v k="$1" '$0 ~ "^"k"=" {print substr($0, index($0, "=") + 1)}' "$ENVF" | head -1 | tr -d "\"'\r"; }
KEY=$(val API_SERVER_KEY); PORT=$(val API_SERVER_PORT); PORT=${PORT:-8443}
cur() { curl -s -m 20 -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/model/options?include_unconfigured=false" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("provider") or "")+"|"+(d.get("model") or ""))' 2>/dev/null; }
restart() { if [ "$SCOPE" = user ]; then systemctl --user restart "$SVC"; else sudo -n systemctl restart "$SVC"; fi; }
up() { for _ in $(seq 1 36); do sleep 5; [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/health")" = 200 ] && return 0; done; return 1; }
BEFORE=$(cur); [ -n "$BEFORE" ] || { echo "ERR The gateway on that machine did not answer, so nothing was changed."; exit 11; }
WANT_P="${PROVIDER:-${BEFORE%%|*}}"
cp -p "$CFG" "$BAK" || { echo "ERR Could not back up the Hermes config, so nothing was changed."; exit 12; }
undo() { cp -p "$BAK" "$CFG"; }
"$H" config set model.default "$MODEL" >/dev/null 2>&1 || { undo; echo "ERR This Hermes version could not set the model from a command. Nothing was changed."; exit 13; }
if [ -n "$PROVIDER" ] && [ "$PROVIDER" != "${BEFORE%%|*}" ]; then
  "$H" config set model.provider "$PROVIDER" >/dev/null 2>&1 || { undo; echo "ERR This Hermes version could not set the provider from a command. Nothing was changed."; exit 13; }
fi
restart || { undo; echo "ERR The gateway restart was refused, so the old settings were put back."; exit 14; }
if up && [ "$(cur)" = "$WANT_P|$MODEL" ]; then echo "OK $WANT_P|$MODEL"; exit 0; fi
undo; restart; up
echo "ERR The gateway did not come back reporting the new model, so the previous settings were restored (now: $(cur))."; exit 20
"""


def _ssh_hosts():
    try:
        with open(os.path.join(AGENT_SSH_DIR, "hosts.json"), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _agent_ssh(ac):
    """The SSH entry for the machine an agent's gateway runs on, if the box has one."""
    host, local = _agent_host(ac)
    if local or not host:
        return host, None
    return host, _ssh_hosts().get(host.lower())


def _model_job(aid):
    with _MODEL_JOBS_LOCK:
        j = _MODEL_JOBS.get(aid)
        return dict(j) if j else None


def _run_model_change(aid, entry, provider, model):
    args = " ".join(shlex.quote(x) for x in (model, provider or "", entry.get("service") or "hermes-gateway.service",
                                             entry.get("scope") or "system"))
    cmd = ["ssh", "-i", os.path.join(AGENT_SSH_DIR, "id_ed25519"), "-o", "BatchMode=yes",
           "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + os.path.join(AGENT_SSH_DIR, "known_hosts"),
           "-o", "ConnectTimeout=15", "-o", "IdentitiesOnly=yes", str(entry.get("target")), "bash -s -- " + args]
    state, msg = "failed", "The change did not finish."
    try:
        r = subprocess.run(cmd, input=_REMOTE_SET_MODEL, capture_output=True, text=True, timeout=480)
        lines = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
        last = lines[-1] if lines else ""
        if r.returncode == 0 and last.startswith("OK "):
            prov, _, mod = last[3:].partition("|")
            state, msg = "done", "Now using " + mod + (" on " + prov if prov else "") + "."
            try:
                with closing(get_db()) as con:
                    con.execute("UPDATE agent_models SET model = ?, provider = ?, ok = 1, error = NULL, checked_at = ? "
                                "WHERE agent_id = ?", (mod, prov or None,
                                                      datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z", aid))
                    con.commit()
            except Exception:
                pass
        elif last.startswith("ERR "):
            msg = last[4:][:300]
        else:
            msg = "Could not log in to that machine or run the change (" + _scrub_secrets((r.stderr or "").strip())[-160:] + ")."
    except subprocess.TimeoutExpired:
        msg = "The change took too long and was stopped. Check that agent's gateway."
    except Exception as e:
        msg = "Could not start the change: " + str(e)[:140]
    with _MODEL_JOBS_LOCK:
        _MODEL_JOBS[aid] = {"state": state, "message": msg, "at": datetime.datetime.utcnow().isoformat() + "Z"}


@app.get("/orchestration/team/{aid}/model")
def team_model_info(aid: str, _auth=Depends(require_auth)):
    """What the Agents page needs to offer a model change for one agent."""
    aid = _safe_id(aid)
    d = _pc_send("GET", "/api/agents/" + aid, what="read the agent")
    ac = d.get("adapterConfig") if isinstance(d.get("adapterConfig"), dict) else {}
    host, entry = _agent_ssh(ac)
    _, local = _agent_host(ac)
    why = None
    if _pc_mode() == "external":
        why = "This dashboard is connected to an external Paperclip in read-only mode."
    elif local:
        why = "This agent runs on this server. Change its model under Advanced, Local models."
    elif not entry:
        why = "This server has no SSH access to " + (host or "that machine") + " yet. On this server run: sudo ./scripts/agent-ssh.sh add <user>@" + (host or "<host>")
    elif not entry.get("can_set"):
        why = "The Hermes on that machine cannot change its model from a command."
    elif not entry.get("can_restart"):
        why = "This server is not allowed to restart the gateway on that machine. Re-run scripts/agent-ssh.sh add for it and follow the note it prints."
    opts = _agent_model_options(aid)
    if not why and not opts:
        why = "That machine has not reported which models it can use yet. Run sudo ./scripts/agent-models.sh on this server."
    return {"can_change": why is None, "why_not": why, "options": opts, "job": _model_job(aid),
            "busy": str(d.get("status") or "").lower() == "running"}


class ModelChange(BaseModel):
    model: str
    provider: str | None = None


@app.post("/orchestration/team/{aid}/model")
def team_model_set(aid: str, m: ModelChange, _auth=Depends(require_auth)):
    _task_writable()
    aid = _safe_id(aid)
    d = _pc_send("GET", "/api/agents/" + aid, what="read the agent")
    ac = d.get("adapterConfig") if isinstance(d.get("adapterConfig"), dict) else {}
    _, entry = _agent_ssh(ac)
    if not entry or not entry.get("can_set") or not entry.get("can_restart"):
        raise HTTPException(status_code=400, detail="This server cannot change the model on that agent's machine yet.")
    if str(d.get("status") or "").lower() == "running":
        raise HTTPException(status_code=409, detail="This agent is working on a task. Changing its model restarts its "
                            "gateway and would interrupt it. Try again when it is idle, or pause it first.")
    model = (m.model or "").strip()
    provider = (m.provider or "").strip()
    if not _MODEL_RE.match(model) or (provider and not _MODEL_RE.match(provider)):
        raise HTTPException(status_code=400, detail="That model or provider name is not valid.")
    opts = _agent_model_options(aid)
    cur = _agent_models().get(aid) or {}
    prov = provider or (cur.get("provider") or "")
    match = [o for o in opts if o.get("slug") == prov and model in o.get("models", [])]
    if not match:
        raise HTTPException(status_code=400, detail="That machine did not list this model for this provider. "
                            "Pick one of the choices shown, or add the provider's key on the machine first.")
    with _MODEL_JOBS_LOCK:
        j = _MODEL_JOBS.get(aid)
        if j and j.get("state") == "running":
            raise HTTPException(status_code=409, detail="A model change is already in progress for this agent.")
        _MODEL_JOBS[aid] = {"state": "running", "message": "Applying the change and restarting the gateway…",
                            "at": datetime.datetime.utcnow().isoformat() + "Z"}
    threading.Thread(target=_run_model_change, args=(aid, entry, provider if provider != (cur.get("provider") or "") else "", model),
                     daemon=True).start()
    return {"ok": True, "job": _model_job(aid)}


# --- AI plan usage ------------------------------------------------------------
# MiniMax M Plan (Token Plan): the plan's own "remains" endpoint reports, per model
# group, the percent of the rolling 5-hour window and of the weekly window that is
# LEFT, plus milliseconds until each resets. Field meanings below were checked
# against a live response and the provider's usage page. Count fields can be 0 on
# real plans, so only the percent and time fields are used.

USAGE_PROVIDERS = {"minimax": {"label": "MiniMax", "url": "https://api.minimax.io/v1/token_plan/remains"}}
_USAGE_CACHE = {}


def _usage_row(provider):
    with closing(get_db()) as con:
        return con.execute("SELECT secret, plan_name, monthly_price, updated_at FROM usage_providers WHERE provider = ?",
                           (provider,)).fetchone()


def _window(remaining_pct, remains_ms, total_ms, now):
    try:
        left = max(0.0, min(100.0, float(remaining_pct)))
        ms = max(0, int(remains_ms))
    except (TypeError, ValueError):
        return None
    used = round(100.0 - left, 1)
    w = {"used_percent": used, "remaining_percent": round(left, 1), "resets_in_seconds": ms // 1000,
         "resets_at": (now + datetime.timedelta(milliseconds=ms)).replace(microsecond=0).isoformat() + "Z",
         "runs_out_in_seconds": None, "on_pace_to_run_out": False}
    elapsed = total_ms - ms if total_ms else 0
    # Projection at the window's average pace so far. Only meaningful once some of the
    # window has passed and something has been used.
    if total_ms and elapsed > total_ms * 0.05 and used > 0:
        to_empty = int(elapsed * (left / used))
        w["runs_out_in_seconds"] = to_empty // 1000
        w["on_pace_to_run_out"] = to_empty < ms
    return w


def _minimax_usage(key):
    now = datetime.datetime.utcnow()
    with httpx.Client(timeout=20.0) as c:
        r = c.get(USAGE_PROVIDERS["minimax"]["url"], headers={"Authorization": "Bearer " + key,
                                                              "Content-Type": "application/json"})
    if r.status_code in (401, 403):
        return {"ok": False, "error": "MiniMax refused the key. It must be the plan's Subscription Key."}
    try:
        d = r.json()
    except Exception:
        return {"ok": False, "error": "MiniMax returned something unreadable (HTTP %d)." % r.status_code}
    base = d.get("base_resp") if isinstance(d.get("base_resp"), dict) else {}
    if r.status_code != 200 or int(base.get("status_code") or 0) != 0:
        return {"ok": False, "error": "MiniMax said: " + _scrub_secrets(str(base.get("status_msg") or ("HTTP %d" % r.status_code)))[:160]}
    groups = []
    for m in d.get("model_remains") or []:
        if not isinstance(m, dict):
            continue
        five_total = (m.get("end_time") or 0) - (m.get("start_time") or 0)
        week_total = (m.get("weekly_end_time") or 0) - (m.get("weekly_start_time") or 0)
        groups.append({"name": str(m.get("model_name") or "general")[:60],
                       "five_hour": _window(m.get("current_interval_remaining_percent"), m.get("remains_time"), five_total, now),
                       "weekly": _window(m.get("current_weekly_remaining_percent"), m.get("weekly_remains_time"), week_total, now)})
    if not groups:
        return {"ok": False, "error": "MiniMax returned no plan usage for this key."}
    return {"ok": True, "groups": groups, "checked_at": now.replace(microsecond=0).isoformat() + "Z"}


@app.get("/usage")
def usage_get(_auth=Depends(require_auth)):
    out = {"providers": []}
    for pid, meta in USAGE_PROVIDERS.items():
        row = _usage_row(pid)
        item = {"id": pid, "label": meta["label"], "configured": bool(row and row[0]),
                "plan_name": row[1] if row else None, "monthly_price": row[2] if row else None, "usage": None}
        if row and row[0]:
            hit = _USAGE_CACHE.get(pid)
            if hit and (datetime.datetime.utcnow() - hit[0]).total_seconds() < 60:
                item["usage"] = hit[1]
            else:
                try:
                    item["usage"] = _minimax_usage(fernet.decrypt(row[0]).decode())
                except Exception as e:
                    item["usage"] = {"ok": False, "error": "Could not reach MiniMax: " + str(e)[:100]}
                _USAGE_CACHE[pid] = (datetime.datetime.utcnow(), item["usage"])
        out["providers"].append(item)
    # What the plan bought, from Paperclip's own 14-day record.
    try:
        cid = _pc_company_id() if _pc_up() else None
        if cid:
            d = _pc_get("/api/companies/" + str(cid) + "/dashboard")
            days = d.get("runActivity") if isinstance(d, dict) else None
            if isinstance(days, list):
                out["runs"] = {"days": len(days), "total": sum(int(x.get("total") or 0) for x in days if isinstance(x, dict)),
                               "succeeded": sum(int(x.get("succeeded") or 0) for x in days if isinstance(x, dict))}
    except Exception:
        pass
    return out


class UsageProviderSet(BaseModel):
    key: str | None = None            # omit to keep the stored key
    plan_name: str | None = None
    monthly_price: float | None = None


@app.put("/usage/{provider}")
def usage_set(provider: str, u: UsageProviderSet, _auth=Depends(require_auth)):
    if provider not in USAGE_PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider.")
    row = _usage_row(provider)
    secret = row[0] if row else None
    if u.key is not None and u.key.strip():
        key = u.key.strip()
        if len(key) < 20 or any(ch.isspace() for ch in key):
            raise HTTPException(status_code=400, detail="That doesn't look like a key.")
        test = _minimax_usage(key)
        if not test.get("ok"):
            raise HTTPException(status_code=400, detail=test.get("error") or "MiniMax did not accept the key.")
        secret = fernet.encrypt(key.encode())
    if not secret:
        raise HTTPException(status_code=400, detail="Add the plan's key first.")
    price = u.monthly_price if u.monthly_price is not None else (row[2] if row else None)
    if price is not None and not (0 <= float(price) <= 100000):
        raise HTTPException(status_code=400, detail="Monthly price looks wrong.")
    name = (u.plan_name.strip()[:80] or None) if u.plan_name is not None else (row[1] if row else None)
    with closing(get_db()) as con:
        con.execute("INSERT OR REPLACE INTO usage_providers (provider, secret, plan_name, monthly_price, updated_at) "
                    "VALUES (?,?,?,?,?)", (provider, secret, name, price, _now().isoformat()))
        con.commit()
    _USAGE_CACHE.pop(provider, None)
    return {"ok": True}


@app.delete("/usage/{provider}")
def usage_delete(provider: str, _auth=Depends(require_auth)):
    with closing(get_db()) as con:
        con.execute("DELETE FROM usage_providers WHERE provider = ?", (provider,))
        con.commit()
    _USAGE_CACHE.pop(provider, None)
    return {"ok": True}


# --- Agent lifecycle + invite (board-key writes) ------------------------------

_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,80}$")


def _safe_id(v):
    """Path segments go straight into upstream Paperclip URLs; only allow plain
    UUID/slug characters so '..', '?', '#' can't reshape the request (F-17)."""
    v = (v or "").strip()
    if not _ID_RE.match(v):
        raise HTTPException(status_code=400, detail="Invalid id.")
    return v


def _pc_post(path, body=None, what="complete the request"):
    return _pc_send("POST", path, body, what)


def _pc_send(method, path, body=None, what="complete the request"):
    key = _pc_key()
    if not key:
        raise HTTPException(status_code=400, detail="Connect Paperclip first (board API key).")
    try:
        with httpx.Client(timeout=45.0, follow_redirects=True) as c:
            r = c.request(method, PAPERCLIP_URL + path, headers={"Authorization": "Bearer " + key},
                          json=body if body is not None else ({} if method != "GET" else None))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Paperclip rejected the request (auth/permission).")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail="Not found in Paperclip.")
    if r.status_code >= 400:
        raise HTTPException(status_code=400, detail="Paperclip could not " + what + ": " + _scrub_secrets(r.text)[:240])
    try:
        return r.json()
    except Exception:
        return {}


@app.post("/orchestration/agents/{aid}/pause")
def pause_agent(aid: str, _auth=Depends(require_auth)):
    d = _pc_post("/api/agents/" + _safe_id(aid) + "/pause", what="pause the agent")
    return {"ok": True, "status": d.get("status")}


@app.post("/orchestration/agents/{aid}/resume")
def resume_agent(aid: str, _auth=Depends(require_auth)):
    """Unpause an agent so Paperclip schedules work for it again. Paperclip
    refuses (409) if the agent's reporting chain is broken; that message is
    passed through so the dashboard can show what to fix."""
    d = _pc_post("/api/agents/" + _safe_id(aid) + "/resume", what="resume the agent")
    return {"ok": True, "status": d.get("status")}


class InvitePrompt(BaseModel):
    message: str = ""


@app.post("/orchestration/invite-prompt")
def invite_prompt(b: InvitePrompt, _auth=Depends(require_auth)):
    """Generate Paperclip's 'invite an agent' prompt — the copy-paste text an
    EXTERNAL agent (e.g. another Hermes, OpenClaw, Claude) reads to send a join
    request. You then approve it under Waiting on you. Links use Paperclip's
    public URL (the tunnel hostname), so the agent can be anywhere."""
    cid = _pc_company_id()
    if not cid:
        raise HTTPException(status_code=400, detail="No Paperclip company found.")
    note = (b.message or "").strip()[:4000]
    body = {"agentMessage": note or None}
    d = _pc_post("/api/companies/" + _safe_id(cid) + "/openclaw/invite-prompt", body,
                 what="create the invite")
    onboarding = d.get("onboardingTextUrl") or ""
    if not onboarding.startswith("http"):
        raise HTTPException(status_code=400, detail=(
            "Paperclip returned no public onboarding URL. Set PAPERCLIP_PUBLIC_URL to the "
            "Paperclip address external agents can reach (e.g. your tunnel hostname)."))
    return {
        "inviteMessage": _build_invite_prompt(onboarding, note),
        "onboardingTextUrl": onboarding,
        "expiresAt": d.get("expiresAt"),
    }


def _build_invite_prompt(onboarding_url, note=""):
    """The copy-paste prompt for an external agent. Mirrors Paperclip's own
    'invite agent' prompt (ui/src/lib/agent-onboarding-prompt.ts): the endpoint
    only returns the onboarding URL; the UI wraps it in these instructions. The
    onboarding.txt it points to carries the full, authoritative instructions."""
    base = onboarding_url.split("/api/", 1)[0]
    test_url = onboarding_url.replace("/onboarding.txt", "/test-resolution")
    lines = [
        "You're invited to join a Paperclip company as an agent.",
        "",
        "First, tell your user you understand the request and are going to onboard into Paperclip. Then work through the steps below.",
    ]
    if note:
        lines += ["", "Note from the company: " + note]
    lines += [
        "",
        "Paperclip onboarding document:",
        "- " + onboarding_url,
        "",
        "Connectivity: Paperclip must be reachable from your runtime. Check with: GET " + base + "/api/health",
        "If your runtime exposes a callback or gateway URL, test Paperclip-to-agent reachability with: "
        + test_url + "?url=<urlencoded-agent-url>",
        "",
        "Join flow:",
        "1. Read the onboarding.txt document above.",
        "2. Submit an agent join request to the invite registration endpoint it describes.",
        "3. Use your own agent name for `agentName`.",
        "4. Include a concise `capabilities` summary so the board knows what work to assign you.",
        "5. Set `adapterType` to the Paperclip adapter that matches your runtime.",
        "6. Put runtime-specific settings in `agentDefaultsPayload`.",
        "7. Wait for board approval before claiming the API key.",
        "8. Claim the Paperclip API key once via the standard claim endpoint and store the parsed `token` field "
        "from the raw HTTP response securely. A value containing `...` or `[redacted]` is a masked preview, not a key.",
        "",
        "Hermes Gateway agents: use `adapterType: \"hermes_gateway\"`. Start Hermes with API_SERVER_ENABLED=true and a "
        "random API_SERVER_KEY, run `hermes gateway run --replace --accept-hooks` (API port 8642). Set "
        "`agentDefaultsPayload.apiBaseUrl` to a Hermes URL Paperclip can reach, `apiKey` to the same value as "
        "API_SERVER_KEY (the gateway key, not the Paperclip key), and `paperclipApiUrl` to " + base + ".",
        "",
        "OpenClaw Gateway agents: use `adapterType: \"openclaw_gateway\"`, set `agentDefaultsPayload.url` to your "
        "ws:// or wss:// gateway URL and `headers[\"x-openclaw-token\"]` to your gateway token.",
        "",
        "After connecting, follow the full onboarding instructions in onboarding.txt.",
    ]
    return "\n".join(lines)


def _company_brief(d):
    return {
        "id": d.get("id"),
        "name": d.get("name"),
        "status": d.get("status"),
        "pauseReason": d.get("pauseReason"),
        "pausedAt": d.get("pausedAt"),
    }


@app.get("/orchestration/company")
def get_company(_auth=Depends(require_auth)):
    """Company-level run state. When the company is paused (manually, or by the
    budget hard-stop), every agent shows paused with reason company_paused and
    agent-level resume has no effect until the company is resumed."""
    try:
        cid = _pc_company_id()
    except PermissionError:
        raise HTTPException(status_code=409, detail="Paperclip is not connected yet.")
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if not cid:
        raise HTTPException(status_code=400, detail="No Paperclip company found.")
    return _company_brief(_pc_send("GET", "/api/companies/" + _safe_id(cid), what="read the company"))


@app.post("/orchestration/company/resume")
def resume_company(_auth=Depends(require_auth)):
    cid = _pc_company_id()
    if not cid:
        raise HTTPException(status_code=400, detail="No Paperclip company found.")
    d = _pc_send("PATCH", "/api/companies/" + _safe_id(cid), {"status": "active"}, what="resume the company")
    return {"ok": True, **_company_brief(d)}


@app.post("/orchestration/company/pause")
def pause_company(_auth=Depends(require_auth)):
    cid = _pc_company_id()
    if not cid:
        raise HTTPException(status_code=400, detail="No Paperclip company found.")
    d = _pc_send("PATCH", "/api/companies/" + _safe_id(cid), {"status": "paused"}, what="pause the company")
    return {"ok": True, **_company_brief(d)}


@app.get("/orchestration/agent-templates")
def agent_templates(_auth=Depends(require_auth)):
    """Starter agents for the Create panel. Edit agent_templates.json to change them."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_templates.json")
    try:
        with open(path, encoding="utf-8") as f:
            items = json.load(f)
    except Exception:
        return {"templates": []}
    out = []
    for t in items if isinstance(items, list) else []:
        if not isinstance(t, dict) or not t.get("name"):
            continue
        role = str(t.get("role") or "general").lower()
        out.append({"id": str(t.get("id") or t["name"]), "name": str(t["name"]),
                    "role": role if role in AGENT_ROLES or role == "general" else "general",
                    "group": str(t.get("group") or ""), "summary": str(t.get("summary") or ""),
                    "instructions": str(t.get("instructions") or "")})
    return {"templates": out}


@app.get("/orchestration/overview")
def orchestration_overview(_auth=Depends(require_auth)):
    if not _pc_up():
        return {"paperclip_up": False, "mode": _pc_mode(), "agents": [], "attention": None, "note": "control plane not running"}
    out = {"paperclip_up": True, "mode": _pc_mode(), "company_id": None, "agents": [], "attention": None, "errors": []}
    try:
        cid = _pc_company_id()
        out["company_id"] = cid
    except PermissionError as e:
        out["errors"].append(str(e)); return out
    except Exception as e:
        out["errors"].append("companies: " + str(e)[:120]); return out
    if not cid:
        out["errors"].append("No company found in Paperclip yet.")
        return out
    try:
        ag = _pc_get("/api/companies/" + str(cid) + "/agents")
        items = ag if isinstance(ag, list) else (ag.get("agents") or ag.get("data") or [])
        out["agents"] = [{"id": a.get("id"),
                          "name": a.get("name") or a.get("agentName") or a.get("displayName") or "Agent",
                          "status": a.get("status") or a.get("state"),
                          "role": a.get("role"),
                          "title": a.get("title"),
                          "reports_to": a.get("reportsTo")} for a in items][:50]
    except Exception as e:
        out["errors"].append("agents: " + str(e)[:120])
    try:
        att = _pc_get("/api/companies/" + str(cid) + "/attention/summary")
        out["attention"] = att
    except Exception as e:
        out["errors"].append("attention: " + str(e)[:120])
    try:
        # Paperclip's own 14-day picture: how many agent runs, how they ended, open work.
        d = _pc_get("/api/companies/" + str(cid) + "/dashboard")
        days = d.get("runActivity") if isinstance(d, dict) else None
        if isinstance(days, list):
            num = lambda k: sum(int(x.get(k) or 0) for x in days if isinstance(x, dict))
            t = d.get("tasks") if isinstance(d.get("tasks"), dict) else {}
            today = days[-1] if days and isinstance(days[-1], dict) else {}
            out["work"] = {"days": len(days), "runs": num("total"), "succeeded": num("succeeded"), "failed": num("failed"),
                           "runs_today": int(today.get("total") or 0), "tasks_in_progress": t.get("inProgress"),
                           "tasks_open": t.get("open"), "tasks_done": t.get("done")}
    except Exception as e:
        out["errors"].append("activity: " + str(e)[:120])
    return out


def _norm_comment(c):
    """Normalize a Paperclip comment into {author, role, text, at} for the Tasks UI."""
    if not isinstance(c, dict):
        return {"author": None, "role": "system", "text": str(c)[:6000], "at": None}
    text = c.get("body") or c.get("content") or c.get("text") or c.get("markdown") or ""
    if not isinstance(text, str):
        text = str(text)
    aid = c.get("authorAgentId") or c.get("agentId")
    uid = c.get("authorUserId") or c.get("userId")
    if aid:
        role = "agent"
    elif uid:
        role = "user"
    else:
        role = c.get("authorKind") or c.get("kind") or "system"
    return {"author": c.get("authorName") or c.get("agentName"),
            "role": role, "agentId": aid, "text": text[:6000],
            "at": c.get("createdAt") or c.get("at")}


@app.get("/orchestration/tasks")
def list_tasks(agent: str = "", _auth=Depends(require_auth)):
    """List the company's tasks (issues) with status + assigned agent, for the
    Tasks page. Read-only; normalizes across Paperclip response shapes."""
    if not _pc_up():
        return {"paperclip_up": False, "tasks": []}
    try:
        cid = _pc_company_id()
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach Paperclip: " + str(e)[:140])
    if not cid:
        return {"paperclip_up": True, "company_id": None, "tasks": []}
    names, slug = {}, None
    try:
        ag = _pc_get("/api/companies/" + str(cid) + "/agents")
        aitems = ag if isinstance(ag, list) else (ag.get("agents") or ag.get("data") or [])
        for a in aitems:
            if isinstance(a, dict):
                names[a.get("id")] = a.get("name") or a.get("displayName") or "Agent"
    except Exception:
        pass
    def _rows(q):
        data = _pc_get("/api/companies/" + str(cid) + "/issues" + q)
        return data if isinstance(data, list) else (data.get("issues") or data.get("items") or data.get("rows") or data.get("data") or [])

    # A board can hold thousands of tasks, so ask for what the page shows instead of an
    # arbitrary first page: everything being worked on, what is waiting on the owner,
    # what is queued, and the most recently finished. Newest activity first.
    issues, seen = [], set()
    for st, lim in (("in_progress", 60), ("in_review,blocked", 80), ("todo", 40), ("done", 60)):
        try:
            for i in _rows("?status=" + st + "&sortField=updated&sortDir=desc&limit=" + str(lim)):
                if isinstance(i, dict) and i.get("id") not in seen:
                    seen.add(i.get("id")); issues.append(i)
        except Exception:
            continue
    if not issues:   # older Paperclip without those filters
        for q in ("?view=rows&limit=50", "?limit=50", ""):
            try:
                issues = _rows(q)
                break
            except Exception:
                continue
    live = set()     # tasks with an agent run in flight right now
    try:
        lr = _pc_get("/api/companies/" + str(cid) + "/live-runs")
        for r in (lr if isinstance(lr, list) else (lr.get("runs") or lr.get("data") or [])):
            if isinstance(r, dict) and r.get("issueId") and str(r.get("status")) in ("running", "queued"):
                live.add(r.get("issueId"))
    except Exception:
        pass
    tasks = []
    for i in issues:
        if not isinstance(i, dict):
            continue
        aid = i.get("assigneeAgentId")
        if agent and aid != agent:
            continue
        tasks.append({
            "key": i.get("identifier") or i.get("humanKey") or i.get("key") or i.get("reference") or i.get("id"),
            "id": i.get("id"),
            "title": i.get("title") or "(untitled task)",
            "status": i.get("status"),
            "running": i.get("id") in live,
            "agentId": aid,
            "agentName": names.get(aid),
            "updatedAt": i.get("updatedAt") or i.get("lastActivityAt") or i.get("createdAt"),
        })
    try:
        comps = _pc_get("/api/companies")
        citems = comps if isinstance(comps, list) else (comps.get("companies") or comps.get("data") or [])
        for c in citems:
            if isinstance(c, dict) and (c.get("id") or c.get("companyId")) == cid:
                slug = c.get("slug") or c.get("key") or c.get("shortName")
    except Exception:
        pass
    return {"paperclip_up": True, "company_id": cid, "company_slug": slug, "tasks": tasks}


@app.get("/orchestration/tasks/{key}")
def task_detail(key: str, _auth=Depends(require_auth)):
    """One task's output: the message thread + deliverable files + latest run status."""
    if not _pc_key():
        raise HTTPException(status_code=400, detail="Connect Paperclip first (board API key).")
    key = _safe_id(key)
    out = {"key": key, "status": None, "messages": [], "deliverables": [], "errors": [],
           "description": None, "issue_status": None, "can_reply": _pc_mode() != "external"}
    try:
        iss = _pc_get("/api/issues/" + key)
        if isinstance(iss, dict):
            out["description"] = _strip_footer(str(iss.get("description") or ""))[:6000] or None
            out["issue_status"] = iss.get("status")
    except Exception as e:
        out["errors"].append("task: " + str(e)[:100])
    try:
        cm = _pc_get("/api/issues/" + key + "/recent-comments")
        comments = cm.get("comments") if isinstance(cm, dict) else cm
        for c in (comments or []):
            out["messages"].append(_norm_comment(c))
        out["messages"].reverse()  # recent-comments is newest-first; show oldest-first
    except Exception as e:
        out["errors"].append("comments: " + str(e)[:100])
    try:
        wp = _pc_get("/api/issues/" + key + "/work-products")
        wpitems = wp if isinstance(wp, list) else (wp.get("workProducts") or wp.get("items") or wp.get("data") or [])
        for w in (wpitems or []):
            if isinstance(w, dict):
                out["deliverables"].append({
                    "name": w.get("name") or w.get("title") or w.get("filename") or "file",
                    "kind": w.get("kind") or w.get("type") or w.get("contentType"),
                    "id": w.get("id"),
                })
    except Exception as e:
        out["errors"].append("work-products: " + str(e)[:100])
    try:
        rs = _pc_get("/api/issues/" + key + "/runs?view=recent")
        ritems = rs if isinstance(rs, list) else (rs.get("runs") or rs.get("items") or rs.get("data") or [])
        if ritems and isinstance(ritems[0], dict):
            out["status"] = ritems[0].get("status")
    except Exception:
        pass
    return out


class TaskReply(BaseModel):
    text: str
    reopen: bool = False


class TaskStatus(BaseModel):
    status: str


_OWNER_TASK_STATUS = {"done": "mark the task done", "todo": "reopen the task", "cancelled": "cancel the task"}


def _task_writable():
    if _pc_mode() == "external":
        raise HTTPException(status_code=400, detail="This install is connected to an external Paperclip in "
                            "read-only mode. Reply to the task in that Paperclip.")


@app.post("/orchestration/tasks/{key}/reply")
def task_reply(key: str, body: TaskReply, _auth=Depends(require_auth)):
    """Owner reply on a task, posted as a board comment. Paperclip wakes the
    assigned agent on a new comment; `reopen` puts a finished task back to work."""
    _task_writable()
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Write a reply first.")
    if len(text) > 8000:
        raise HTTPException(status_code=400, detail="That reply is too long (8,000 characters max).")
    payload = {"body": text}
    if body.reopen:
        payload["reopen"] = True
    _pc_send("POST", "/api/issues/" + _safe_id(key) + "/comments", payload, what="post the reply")
    return {"ok": True}


@app.post("/orchestration/tasks/{key}/status")
def task_set_status(key: str, body: TaskStatus, _auth=Depends(require_auth)):
    """Owner-only status changes from the Tasks tab: done, reopen (todo), cancel."""
    _task_writable()
    st = (body.status or "").strip().lower()
    if st not in _OWNER_TASK_STATUS:
        raise HTTPException(status_code=400, detail="Status must be one of: done, todo, cancelled.")
    d = _pc_send("PATCH", "/api/issues/" + _safe_id(key), {"status": st}, what=_OWNER_TASK_STATUS[st])
    return {"ok": True, "status": (d.get("status") if isinstance(d, dict) else None) or st}


class BudgetSet(BaseModel):
    budget_cents: int = 0


@app.post("/orchestration/budget")
def set_budget(b: BudgetSet, _auth=Depends(require_auth)):
    """Set the company's monthly dollar cap (0 turns it off). Turning it off or
    raising it also lets Paperclip release a budget-owned company pause."""
    cents = max(0, min(int(b.budget_cents or 0), 100_000_000))
    cid = _pc_company_id()
    if not cid:
        raise HTTPException(status_code=400, detail="No Paperclip company found.")
    _pc_send("PATCH", "/api/companies/" + _safe_id(cid) + "/budgets",
             {"budgetMonthlyCents": cents}, what="update the budget")
    cleared, resumed = [], []
    if cents == 0:
        # Per-agent caps are blind to Hermes cost the same way the company cap is
        # (unpriced usage fails closed), and they keep a "budget" hold on the agent
        # that a manual resume doesn't clear. Turning the cap off clears them too.
        for p in _budget_policies(cid):
            if p.get("scopeType") == "agent" and p.get("isActive") and (p.get("amount") or 0) > 0 and p.get("scopeId"):
                try:
                    _pc_send("PATCH", "/api/agents/" + _safe_id(p["scopeId"]) + "/budgets",
                             {"budgetMonthlyCents": 0}, what="clear an agent budget")
                    cleared.append(p.get("scopeName") or p["scopeId"])
                except HTTPException:
                    pass
        # Nudge budget-held agents so Paperclip re-evaluates now, not at next tick.
        try:
            ag = _pc_get("/api/companies/" + str(cid) + "/agents")
            items = ag if isinstance(ag, list) else ((ag or {}).get("agents") or (ag or {}).get("data") or [])
            for a in items:
                if isinstance(a, dict) and a.get("status") == "paused" and a.get("pauseReason") == "budget":
                    try:
                        _pc_post("/api/agents/" + _safe_id(a.get("id")) + "/resume", what="resume an agent")
                        resumed.append(a.get("name"))
                    except HTTPException:
                        pass
        except Exception:
            pass
    return {"ok": True, "budget_cents": cents, "agent_caps_cleared": cleared, "agents_nudged": resumed}


def _budget_policies(cid):
    try:
        ov = _pc_get("/api/companies/" + str(cid) + "/budgets/overview")
    except Exception:
        return []
    pol = ov.get("policies") if isinstance(ov, dict) else None
    return [p for p in (pol or []) if isinstance(p, dict)]


@app.get("/orchestration/budget")
def get_budget(_auth=Depends(require_auth)):
    """The company's monthly spend ceiling and spend-to-date, for the dashboard.
    Paperclip auto-pauses when spend reaches the cap (budget hard-stop)."""
    out = {"paperclip_up": bool(_pc_up()), "budget_cents": None, "spent_cents": None,
           "default_cents": COMPANY_BUDGET_CENTS}
    if not out["paperclip_up"]:
        return out
    try:
        cid = _pc_company_id()
    except Exception:
        cid = None
    if not cid:
        return out
    try:
        ov = _pc_get("/api/companies/" + str(cid) + "/budgets/overview")
    except Exception:
        ov = None
    if isinstance(ov, dict) and isinstance(ov.get("policies"), list):
        for p in ov["policies"]:
            if isinstance(p, dict) and p.get("scopeType") == "company":
                if isinstance(p.get("amount"), (int, float)):
                    out["budget_cents"] = int(p["amount"])
                if isinstance(p.get("observedAmount"), (int, float)):
                    out["spent_cents"] = int(p["observedAmount"])
                out["hard_stop"] = bool(p.get("hardStopEnabled"))
                break
        # Every active cap (company AND per-agent), so a stuck "paused (budget)"
        # agent can be traced to its policy instead of guessed at.
        out["policies"] = [{
            "scope": p.get("scopeType"), "name": p.get("scopeName"),
            "amount_cents": p.get("amount"), "spent_cents": p.get("observedAmount"),
            "active": bool(p.get("isActive")), "hard_stop": bool(p.get("hardStopEnabled")),
            "paused": bool(p.get("paused")),
        } for p in ov["policies"] if isinstance(p, dict) and p.get("isActive") and (p.get("amount") or 0) > 0]
    return out


# --- Gateway run-attempt fast-stop (Phase 2) --------------------------------
# These back the TLS gateway's auth_request. /gateway/authorize is internal:
# nginx calls it as a subrequest on every request to the Hermes runs API and it
# returns 200 (allow) or 403 (halt). The public dashboard proxy blocks
# /api/connectors/gateway/* so it can't be reached from a browser; the only
# caller is the in-cluster gateway-tls container. blocked/unblock are authed and
# drive the Tasks page "halted" banner.

def _issue_from_skey(skey):
    # paperclip:company:{cid}:agent:{aid}:issue:{issueId} -> issueId
    if not skey or "issue:" not in skey:
        return None
    return skey.rsplit("issue:", 1)[-1].strip() or None


@app.api_route("/gateway/authorize",
               methods=["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
def gateway_authorize(request: Request):
    """Internal auth_request target. Meters only run-creation (POST /v1/runs) per
    session key; everything else (status, SSE events, stop) always passes. Over
    RUN_MAX_ATTEMPTS it returns 403 so the adapter sees a terminal error and the
    task halts instead of looping. Fails open on any ledger error — a guardrail
    must never be the reason a legit run can't start."""
    method = (request.headers.get("X-Gw-Method") or request.method or "").upper()
    uri = request.headers.get("X-Gw-Uri") or ""
    skey = (request.headers.get("X-Hermes-Session-Key") or "").strip()
    path = uri.split("?", 1)[0].rstrip("/")

    # Only count run-creation. Status/events/stop and anything else pass through.
    if not (method == "POST" and path == "/v1/runs"):
        return Response(status_code=200)
    # Metering off, or no session key to meter on -> allow.
    if RUN_MAX_ATTEMPTS <= 0 or not skey:
        return Response(status_code=200)

    now = _now().isoformat()
    try:
        with closing(get_db()) as con:
            row = con.execute(
                "SELECT attempts FROM run_budget WHERE session_key=?", (skey,)
            ).fetchone()
            attempts = row[0] if row else 0
            if attempts >= RUN_MAX_ATTEMPTS:
                con.execute(
                    "UPDATE run_budget SET blocked=1, "
                    "blocked_at=COALESCE(blocked_at,?), last_at=? WHERE session_key=?",
                    (now, now, skey))
                con.commit()
                return Response(status_code=403)  # terminal -> adapter halts the task
            if row:
                con.execute(
                    "UPDATE run_budget SET attempts=attempts+1, last_at=? WHERE session_key=?",
                    (now, skey))
            else:
                con.execute(
                    "INSERT INTO run_budget(session_key, issue_key, attempts, blocked, "
                    "first_at, last_at) VALUES(?,?,?,?,?,?)",
                    (skey, _issue_from_skey(skey), 1, 0, now, now))
            con.commit()
    except Exception:
        return Response(status_code=200)
    return Response(status_code=200)


@app.get("/gateway/blocked")
def gateway_blocked(_auth=Depends(require_auth)):
    """Tasks the fast-stop has halted, for the dashboard banner."""
    out = []
    try:
        with closing(get_db()) as con:
            rows = con.execute(
                "SELECT session_key, issue_key, attempts, blocked_at FROM run_budget "
                "WHERE blocked=1 ORDER BY blocked_at DESC").fetchall()
        for r in rows:
            out.append({"session_key": r[0], "issue_key": r[1],
                        "attempts": r[2], "blocked_at": r[3]})
    except Exception:
        pass
    return {"blocked": out, "max_attempts": RUN_MAX_ATTEMPTS}


class GwUnblock(BaseModel):
    issue: str = ""
    session_key: str = ""


@app.post("/gateway/unblock")
def gateway_unblock(b: GwUnblock, _auth=Depends(require_auth)):
    """Clear a task's ledger so it can run again (human action after reviewing
    why it was looping). Deletes the row -> the task starts fresh at 0 attempts."""
    key = (b.session_key or "").strip()
    iss = (b.issue or "").strip()
    if not key and not iss:
        raise HTTPException(status_code=400, detail="Provide issue or session_key")
    try:
        with closing(get_db()) as con:
            if key:
                con.execute("DELETE FROM run_budget WHERE session_key=?", (key,))
            else:
                con.execute("DELETE FROM run_budget WHERE issue_key=?", (iss,))
            con.commit()
    except Exception:
        raise HTTPException(status_code=500, detail="Could not unblock the task")
    return {"ok": True}


# ===========================================================================
# CHAT TOOLS (MCP)
# Gives the Hermes chat agent tools to run the business: delegate work to the
# right Paperclip agent, ask the CEO for a hiring review, and build n8n
# workflows. Hermes loads this as an MCP server (config.yaml -> mcp_servers).
#
# Guardrails, enforced here rather than left to the prompt:
#   - Workflows are always created INACTIVE. There is no "activate" tool. An
#     agent files an activation request; the owner approves it in Automations.
#   - A live (active) workflow cannot be edited through these tools.
#   - Hiring is a proposal task for the CEO agent; nothing here creates agents.
#   - Task creation is rate-limited (CHAT_TASKS_PER_HOUR).
#   - Against an EXTERNAL Paperclip the delegation tools are read-only.
# Internal only: bearer token + blocked on the public proxy.
# ===========================================================================
import hmac
import time
import threading

CHAT_TOOLS_TOKEN = os.environ.get("CHAT_TOOLS_TOKEN", "").strip()
CHAT_TASKS_PER_HOUR = _env_int("CHAT_TASKS_PER_HOUR", 20)
_MCP_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
_task_times, _task_lock = [], threading.Lock()


class ToolError(Exception):
    """A failure the model should read and act on (shown as the tool result)."""


def _n8n_send(method, path, body=None):
    conn = _n8n_conn()
    if not conn:
        raise ToolError("The automation engine (n8n) is not connected yet. Ask the owner to open the "
                        "Automations tab and connect it.")
    try:
        with httpx.Client(timeout=30.0, follow_redirects=True) as c:
            r = c.request(method, conn["base_url"] + path, headers={"X-N8N-API-KEY": conn["api_key"]},
                          json=body if method != "GET" else None,
                          params=body if method == "GET" else None)
    except Exception as e:
        raise ToolError("Could not reach n8n: " + str(e)[:140])
    if r.status_code in (401, 403):
        raise ToolError("n8n rejected the stored API key. Ask the owner to reconnect it in the Automations tab.")
    if r.status_code == 404:
        raise ToolError("n8n has no workflow or run with that id.")
    if r.status_code >= 400:
        raise ToolError("n8n refused the request: " + _scrub_secrets(r.text)[:400])
    try:
        return r.json()
    except Exception:
        return {}


def _tool_agents():
    try:
        cid = _pc_company_id()
        ag = _pc_get("/api/companies/" + str(cid) + "/agents") if cid else []
    except PermissionError:
        raise ToolError("Paperclip is not connected. Ask the owner to connect it in the Orchestration tab.")
    except Exception as e:
        raise ToolError("Could not reach Paperclip: " + str(e)[:140])
    items = ag if isinstance(ag, list) else ((ag or {}).get("agents") or (ag or {}).get("data") or [])
    return cid, [a for a in items if isinstance(a, dict) and a.get("id")]


def _agent_name(a):
    return a.get("name") or a.get("agentName") or a.get("displayName") or "Agent"


def _find_agent(agents, ref):
    ref = (ref or "").strip().lower()
    if not ref:
        return None
    for a in agents:
        if str(a.get("id")).lower() == ref or _agent_name(a).lower() == ref:
            return a
    close = [a for a in agents if ref in _agent_name(a).lower()]
    return close[0] if len(close) == 1 else None


def _require_bundled():
    if _pc_mode() == "external":
        raise ToolError("This install is connected to an external Paperclip in read-only mode, so tasks "
                        "cannot be created from chat. Tell the owner to create the task in Paperclip.")


def _create_issue(cid, agent, title, description, priority):
    with _task_lock:
        now = time.time()
        _task_times[:] = [t for t in _task_times if now - t < 3600]
        if CHAT_TASKS_PER_HOUR > 0 and len(_task_times) >= CHAT_TASKS_PER_HOUR:
            raise ToolError("Task limit reached (%d per hour). Stop creating tasks and tell the owner."
                            % CHAT_TASKS_PER_HOUR)
        _task_times.append(now)
    pr = priority if priority in ("low", "medium", "high", "urgent") else "medium"
    biz = _business_text()
    if biz:
        description = description[:6000] + "\n\n--- About the business ---\n" + biz[:2000]
    body = {"title": title[:200], "description": description[:8000],
            "assigneeAgentId": agent["id"], "priority": pr}
    try:
        d = _pc_send("POST", "/api/companies/" + _safe_id(cid) + "/issues", body, what="create the task")
    except HTTPException as e:
        raise ToolError(str(e.detail))
    return d.get("humanKey") or d.get("identifier") or d.get("key") or d.get("id")


def t_list_agents(a):
    _, agents = _tool_agents()
    if not agents:
        return ("There are no agents yet. Suggest the owner create one from a template in "
                "Orchestration > Create agent.")
    lines = []
    for ag in agents:
        bits = [_agent_name(ag), "role: " + str(ag.get("role") or "general"),
                "status: " + str(ag.get("status") or "unknown")]
        desc = ag.get("title") or ag.get("capabilities")
        if desc:
            bits.append("does: " + str(desc)[:200])
        lines.append("- " + " | ".join(bits))
    return "\n".join(lines)


def t_assign_task(a):
    _require_bundled()
    title = (a.get("title") or "").strip()
    desc = (a.get("description") or "").strip()
    if not title or not desc:
        raise ToolError("Both title and description are required.")
    cid, agents = _tool_agents()
    ag = _find_agent(agents, a.get("agent"))
    if not ag:
        raise ToolError("No agent matches '%s'. Agents: %s. If none fits the work, use request_hiring_review."
                        % (a.get("agent"), ", ".join(_agent_name(x) for x in agents) or "none"))
    key = _create_issue(cid, ag, title, desc, a.get("priority"))
    note = ""
    if ag.get("status") == "paused":
        note = " Note: this agent is paused, so the task will wait until the owner resumes it in Orchestration."
    return "Task %s created and assigned to %s.%s The owner can follow it in the Tasks tab." % (
        key, _agent_name(ag), note)


def t_list_tasks(a):
    try:
        d = list_tasks(agent="", _auth=None)
    except HTTPException as e:
        raise ToolError(str(e.detail))
    tasks = d.get("tasks") or []
    want = (a.get("agent") or "").strip().lower()
    if want:
        tasks = [t for t in tasks if want in (t.get("agentName") or "").lower()]
    if not tasks:
        return "No tasks found."
    return "\n".join("- %s | %s | %s | %s" % (t.get("key"), t.get("status") or "?",
                                               t.get("agentName") or "unassigned", t.get("title"))
                     for t in tasks[:30])


def t_task_status(a):
    key = (a.get("task") or "").strip()
    if not re.match(r"^[A-Za-z0-9-]{1,80}$", key):
        raise ToolError("Give the task key exactly as list_tasks shows it, for example ABC-12.")
    try:
        d = task_detail(key, _auth=None)
    except HTTPException as e:
        raise ToolError(str(e.detail))
    out = ["Task %s. Latest run: %s" % (key, d.get("status") or "no run yet")]
    for m in (d.get("messages") or [])[-3:]:
        out.append("[%s] %s" % (m.get("author") or m.get("role") or "note", (m.get("text") or "")[:1500]))
    if d.get("deliverables"):
        out.append("Files: " + ", ".join(x.get("name") or "file" for x in d["deliverables"][:10]))
    return "\n\n".join(out)


def t_request_hiring_review(a):
    _require_bundled()
    need = (a.get("need") or "").strip()
    if not need:
        raise ToolError("Describe the need.")
    cid, agents = _tool_agents()
    ceo = next((x for x in agents if str(x.get("role") or "").lower() == "ceo"), None)
    if not ceo:
        return ("There is no CEO agent to run a hiring review. Tell the owner: create one from the CEO "
                "template in Orchestration > Create agent, or create the agent they need directly from a "
                "template there.")
    team = ", ".join("%s (%s)" % (_agent_name(x), x.get("role") or "general") for x in agents)
    desc = ("The owner asked for something no current agent covers.\n\nNeed: " + need[:3000] +
            "\n\nOwner's request, in their words: " + (a.get("request") or "(not given)")[:2000] +
            "\n\nCurrent team: " + team +
            "\n\nRun a hiring review and reply on this task with a recommendation the owner can approve "
            "or decline:\n1. Is this recurring, or a one-off?\n2. Could an n8n workflow do it with no "
            "agent? Prefer that when the steps are the same every time.\n3. Could an existing agent take "
            "it with a small change to their instructions?\n4. Only if not: propose a new agent - name, "
            "role, what it would do, what access it needs.\n\nYou propose; the owner decides. Do not "
            "create, change or remove any agent.")
    key = _create_issue(cid, ceo, "Hiring review: " + need[:120], desc, "medium")
    return ("Hiring review %s sent to %s. Tell the owner the recommendation will appear in the Tasks tab "
            "for them to approve or decline." % (key, _agent_name(ceo)))


def t_list_workflows(a):
    wfs = (_n8n_send("GET", "/api/v1/workflows", {"limit": 100}).get("data")) or []
    if not wfs:
        return "No workflows yet."
    return "\n".join("- id %s | %s | %s" % (w.get("id"), "ACTIVE" if w.get("active") else "inactive",
                                             w.get("name") or "Workflow") for w in wfs)


def t_workflow_failures(a):
    try:
        lim = max(1, min(int(a.get("limit") or 10), 25))
    except Exception:
        lim = 10
    ex = (_n8n_send("GET", "/api/v1/executions", {"status": "error", "limit": lim}).get("data")) or []
    if not ex:
        return "No failed runs."
    names = {str(w.get("id")): w.get("name") for w in
             (_n8n_send("GET", "/api/v1/workflows", {"limit": 100}).get("data") or [])}
    return "\n".join("- run %s | workflow %s (%s) | %s" % (
        e.get("id"), e.get("workflowId"), names.get(str(e.get("workflowId"))) or "?", e.get("startedAt"))
        for e in ex)


def _wf_id(a):
    wid = str(a.get("workflow_id") or "").strip()
    if not re.match(r"^[A-Za-z0-9_-]{1,64}$", wid):
        raise ToolError("Give the workflow id exactly as list_workflows shows it.")
    return wid


def t_get_workflow(a):
    w = _n8n_send("GET", "/api/v1/workflows/" + _wf_id(a))
    slim = {"id": w.get("id"), "name": w.get("name"), "active": bool(w.get("active")),
            "nodes": w.get("nodes"), "connections": w.get("connections"), "settings": w.get("settings")}
    text = json.dumps(slim, default=str)
    return text if len(text) <= 60000 else text[:60000] + "\n...(truncated)"


def t_failed_run_detail(a):
    rid = str(a.get("run_id") or "").strip()
    if not re.match(r"^[0-9A-Za-z_-]{1,40}$", rid):
        raise ToolError("Give the run id exactly as workflow_failures shows it.")
    e = _n8n_send("GET", "/api/v1/executions/" + rid, {"includeData": "true"})
    rd = ((e.get("data") or {}).get("resultData") or {}) if isinstance(e.get("data"), dict) else {}
    err = rd.get("error") or {}
    out = {"run": e.get("id"), "workflowId": e.get("workflowId"), "status": e.get("status"),
           "startedAt": e.get("startedAt"), "failedNode": rd.get("lastNodeExecuted"),
           "error": _scrub_secrets(str(err.get("message") or err.get("description") or err or "unknown"))[:2000]}
    return json.dumps(out, default=str)


def _wf_body(a):
    name = (a.get("name") or "").strip()
    nodes, conns = a.get("nodes"), a.get("connections")
    if not name:
        raise ToolError("name is required.")
    if not isinstance(nodes, list) or not nodes or not all(isinstance(n, dict) for n in nodes):
        raise ToolError("nodes must be a non-empty list of n8n node objects.")
    if len(nodes) > 60:
        raise ToolError("Too many nodes (max 60). Split this into smaller workflows.")
    if not isinstance(conns, dict):
        raise ToolError("connections must be an n8n connections object (use {} for a single node).")
    body = {"name": name[:120], "nodes": nodes, "connections": conns,
            "settings": a.get("settings") if isinstance(a.get("settings"), dict) else {"executionOrder": "v1"}}
    if len(json.dumps(body, default=str)) > 250000:
        raise ToolError("Workflow is too large.")
    return body


def t_create_workflow(a):
    w = _n8n_send("POST", "/api/v1/workflows", _wf_body(a))
    return ("Workflow '%s' created with id %s. It is INACTIVE and will not run. Credentials must be added "
            "by the owner inside n8n. When it is ready, call request_activation so the owner can approve "
            "switching it on." % (w.get("name"), w.get("id")))


def t_update_workflow(a):
    wid = _wf_id(a)
    cur = _n8n_send("GET", "/api/v1/workflows/" + wid)
    if cur.get("active"):
        raise ToolError("That workflow is live, and live workflows cannot be changed from here. Build the "
                        "fix as a new workflow with create_workflow, then call request_activation and "
                        "explain that it replaces workflow %s." % wid)
    w = _n8n_send("PUT", "/api/v1/workflows/" + wid, _wf_body(a))
    return "Workflow %s updated. It is still inactive." % (w.get("id") or wid)


def t_request_activation(a):
    wid = _wf_id(a)
    summary = (a.get("summary") or "").strip()
    if len(summary) < 20:
        raise ToolError("Give a plain-English summary: what it does, what triggers it, what it sends or changes.")
    w = _n8n_send("GET", "/api/v1/workflows/" + wid)
    if w.get("active"):
        return "That workflow is already active."
    with closing(get_db()) as con:
        row = con.execute("SELECT id FROM workflow_requests WHERE workflow_id=? AND status='pending'",
                          (wid,)).fetchone()
        if row:
            con.execute("UPDATE workflow_requests SET summary=?, workflow_name=? WHERE id=?",
                        (summary[:2000], w.get("name"), row[0]))
        else:
            con.execute("INSERT INTO workflow_requests(workflow_id, workflow_name, summary, requested_by, "
                        "status, created_at) VALUES(?,?,?,?,?,?)",
                        (wid, w.get("name"), summary[:2000], (a.get("requested_by") or "")[:80],
                         "pending", _now().isoformat()))
        con.commit()
    return ("Activation of '%s' is now waiting for the owner. Tell them: open the Automations tab and "
            "approve or decline it under Waiting for your approval. You cannot activate it yourself."
            % (w.get("name") or wid))


def _business():
    try:
        with closing(get_db()) as con:
            row = con.execute("SELECT name, about FROM business_profile WHERE id=1").fetchone()
    except Exception:
        row = None
    return {"name": (row[0] if row else "") or "", "about": (row[1] if row else "") or ""}


def _business_text():
    b = _business()
    if not b["name"] and not b["about"]:
        return ""
    return ("Business name: " + (b["name"] or "(not set)") + ("\n" + b["about"] if b["about"] else "")).strip()


def t_get_business_profile(a):
    return _business_text() or ("The owner has not filled in the business profile yet. Ask them for the "
                                "detail you need, and suggest they fill it in under Orchestration.")


def _own_issue(a):
    """Resolve a task and check the caller is the agent it is assigned to."""
    _require_bundled()
    key = (a.get("task") or "").strip()
    aid = (a.get("agent_id") or "").strip()
    if not re.match(r"^[A-Za-z0-9-]{1,80}$", key):
        raise ToolError("Give the task id or key exactly as it appears in your task brief.")
    if not re.match(r"^[A-Za-z0-9-]{1,80}$", aid):
        raise ToolError("Give your Agent ID exactly as it appears under 'Paperclip runtime identity'.")
    try:
        issue = _pc_get("/api/issues/" + key)
    except PermissionError:
        raise ToolError("Paperclip is not connected.")
    except Exception:
        raise ToolError("No task found with that id.")
    if not isinstance(issue, dict) or not issue.get("id"):
        raise ToolError("No task found with that id.")
    if str(issue.get("assigneeAgentId") or "") != aid:
        raise ToolError("That task is not assigned to you, so you cannot change it.")
    return issue


def _set_issue(issue, status, comment):
    try:
        _pc_send("PATCH", "/api/issues/" + _safe_id(str(issue["id"])), {"status": status, "comment": comment[:6000]},
                 what="update the task")
    except HTTPException as e:
        raise ToolError(str(e.detail))


def t_complete_task(a):
    summary = (a.get("summary") or "").strip()
    if len(summary) < 5:
        raise ToolError("Give a one-line summary of what you delivered.")
    issue = _own_issue(a)
    if issue.get("status") in ("done", "cancelled"):
        return "That task is already closed. Stop here."
    _set_issue(issue, "done", "Completed: " + summary)
    return "Task marked done. You are finished; stop here."


def t_need_owner_input(a):
    q = (a.get("question") or "").strip()
    if len(q) < 10:
        raise ToolError("Ask a clear, specific question the owner can answer.")
    issue = _own_issue(a)
    if issue.get("status") in ("done", "cancelled"):
        return "That task is already closed. Stop here."
    _set_issue(issue, "blocked", "Waiting on the owner: " + q)
    return "The task is now waiting on the owner. Stop here; you will be woken when they reply."


def _schema(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


_S = {"type": "string"}
_ROUTING = (" Routing rule for owner requests: answer quick questions yourself; if the work is the same "
            "steps every time on a schedule or trigger (every morning, every week, whenever X happens), "
            "build an n8n workflow, NOT a scheduled job or cron job: a scheduled job runs the AI model on "
            "every run and costs usage credits, a workflow does not. If it needs judgment, assign it to "
            "the matching agent; if it is an ongoing role no agent covers, request a hiring review. Ask "
            "the owner for missing details before building. Load the running-the-business skill for the "
            "full procedure.")
# name -> (handler, scope, description, schema). scope "chat" = chat agent only.
MCP_TOOLS = {
    "list_agents": (t_list_agents, "chat",
        "List the business's agents with their role, status and what they do. Call this before "
        "assigning work so you pick the right agent." + _ROUTING, _schema({})),
    "assign_task": (t_assign_task, "chat",
        "Give a piece of work that needs judgment to one agent. Creates a task the owner can follow in "
        "the Tasks tab. Only the owner's chat assistant assigns tasks; an agent working on a task must "
        "not. Write the description so the agent can act without this conversation: goal, context, "
        "what done looks like. Do not use for work that is the same steps every time on a "
        "schedule or trigger; that belongs in an n8n workflow.",
        _schema({"agent": {"type": "string", "description": "Agent name from list_agents"},
                 "title": _S, "description": _S,
                 "priority": {"type": "string", "enum": ["low", "medium", "high", "urgent"]}},
                ("agent", "title", "description"))),
    "list_tasks": (t_list_tasks, "chat", "List current tasks with status and assigned agent.",
        _schema({"agent": {"type": "string", "description": "Optional agent name filter"}})),
    "task_status": (t_task_status, "chat",
        "Latest run status and most recent replies on one task.",
        _schema({"task": {"type": "string", "description": "Task key from list_tasks"}}, ("task",))),
    "request_hiring_review": (t_request_hiring_review, "chat",
        "Use when the owner asks for 'someone to handle' an ongoing responsibility (a role, such as "
        "payroll, bookkeeping, support) that no current agent covers. A schedule in the request does "
        "not make it a workflow: a role needs judgment. "
        "Sends the CEO agent a hiring review; the CEO proposes whether to add an agent and the owner "
        "decides. This never creates an agent.",
        _schema({"need": {"type": "string", "description": "The work that has no owner"},
                 "request": {"type": "string", "description": "The owner's request in their words"}},
                ("need",))),
    "complete_task": (t_complete_task, "all",
        "For an agent working on an assigned task: call this when the work is finished and your result "
        "is posted on the task. This is what gives the task its final disposition; without it the task "
        "is treated as unfinished and you will be woken again.",
        _schema({"task": {"type": "string", "description": "Task id or key from your task brief"},
                 "agent_id": {"type": "string", "description": "Your Agent ID from the runtime identity"},
                 "summary": _S}, ("task", "agent_id", "summary"))),
    "need_owner_input": (t_need_owner_input, "all",
        "For an agent working on an assigned task: call this when you cannot finish without the owner "
        "(a decision, a login, missing information). Marks the task as waiting on them.",
        _schema({"task": _S, "agent_id": _S, "question": _S}, ("task", "agent_id", "question"))),
    "get_business_profile": (t_get_business_profile, "all",
        "The business's name and what the owner has said about it (services, hours, tone, contact). "
        "Use it instead of placeholders such as [Company Name].", _schema({})),
    "list_workflows": (t_list_workflows, "all",
        "List n8n workflows with id and whether each is active. Check here before building a new one.",
        _schema({})),
    "workflow_failures": (t_workflow_failures, "all", "Recent failed workflow runs.",
        _schema({"limit": {"type": "integer"}})),
    "failed_run_detail": (t_failed_run_detail, "all",
        "Which node failed and the error message for one failed run.",
        _schema({"run_id": _S}, ("run_id",))),
    "get_workflow": (t_get_workflow, "all", "Full definition (nodes and connections) of one workflow.",
        _schema({"workflow_id": _S}, ("workflow_id",))),
    "create_workflow": (t_create_workflow, "all",
        "Create a new n8n workflow. It is always created INACTIVE. Use this instead of a scheduled or "
        "cron job for anything recurring. A workflow may prepare, remind and report, but must never move "
        "money (payroll, payments, refunds, transfers) on its own. Use for repeatable work: same steps "
        "every time, on a schedule or trigger. Not worth it for a one-off task. Prefer plain n8n nodes; "
        "add an AI or agent step only for the one step that needs judgment. Never put passwords, API "
        "keys or tokens in node parameters; reference n8n credentials, which the owner adds in n8n.",
        _schema({"name": _S,
                 "nodes": {"type": "array", "items": {"type": "object"}, "description": "n8n node objects"},
                 "connections": {"type": "object", "description": "n8n connections object"},
                 "settings": {"type": "object"}}, ("name", "nodes", "connections"))),
    "update_workflow": (t_update_workflow, "all",
        "Replace the definition of an INACTIVE workflow. Live workflows cannot be changed here.",
        _schema({"workflow_id": _S, "name": _S,
                 "nodes": {"type": "array", "items": {"type": "object"}},
                 "connections": {"type": "object"}, "settings": {"type": "object"}},
                ("workflow_id", "name", "nodes", "connections"))),
    "request_activation": (t_request_activation, "all",
        "Ask the owner to switch a workflow on. You cannot activate workflows yourself. The summary is "
        "what the owner reads before approving: what it does, what triggers it, and what it sends or "
        "changes.",
        _schema({"workflow_id": _S, "summary": _S, "requested_by": {"type": "string",
                 "description": "Your agent name"}}, ("workflow_id", "summary"))),
}


def _mcp_rpc(msg, scope):
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if "id" not in msg:
        return None  # notification
    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}
    visible = {n: t for n, t in MCP_TOOLS.items() if scope == "chat" or t[1] == "all"}
    if method == "initialize":
        want = params.get("protocolVersion")
        return ok({"protocolVersion": want if want in _MCP_VERSIONS else _MCP_VERSIONS[0],
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "agent-os", "version": "1.0"},
                   "instructions": "Tools for running the business: delegate to agents, and build n8n "
                                   "workflows. Workflow activation and hiring always need the owner's "
                                   "approval." + _ROUTING})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": [{"name": n, "description": t[2], "inputSchema": t[3]} for n, t in visible.items()]})
    if method == "tools/call":
        name = params.get("name")
        if name not in visible:
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "Unknown tool"}}
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            text, is_err = visible[name][0](args), False
        except ToolError as e:
            text, is_err = str(e), True
        except Exception as e:
            text, is_err = "Tool failed: " + _scrub_secrets(str(e))[:200], True
        return ok({"content": [{"type": "text", "text": str(text)}], "isError": is_err})
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}}


async def _mcp_http(request: Request, scope: str):
    if not CHAT_TOOLS_TOKEN:
        return Response(status_code=404)
    got = request.headers.get("authorization") or ""
    if not hmac.compare_digest(got.encode(), ("Bearer " + CHAT_TOOLS_TOKEN).encode()):
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    if request.method != "POST":
        return Response(status_code=405, headers={"Allow": "POST"})
    try:
        payload = json.loads(await request.body())
    except Exception:
        return JSONResponse(status_code=400, content={"jsonrpc": "2.0", "id": None,
                                                      "error": {"code": -32700, "message": "Parse error"}})
    from starlette.concurrency import run_in_threadpool
    if isinstance(payload, list):
        outs = [o for o in [await run_in_threadpool(_mcp_rpc, m, scope) for m in payload[:20]] if o]
        return JSONResponse(outs) if outs else Response(status_code=202)
    out = await run_in_threadpool(_mcp_rpc, payload, scope)
    return JSONResponse(out) if out else Response(status_code=202)


@app.api_route("/mcp", methods=["GET", "POST", "DELETE"])
async def mcp_chat(request: Request):
    return await _mcp_http(request, "chat")


@app.api_route("/mcp/agent", methods=["GET", "POST", "DELETE"])
async def mcp_agent(request: Request):
    """Subset for working agents (n8n tools only, no delegation)."""
    return await _mcp_http(request, "agent")


class BusinessProfile(BaseModel):
    name: str = ""
    about: str = ""


@app.get("/orchestration/business")
def get_business(_auth=Depends(require_auth)):
    return _business()


@app.put("/orchestration/business")
def put_business(b: BusinessProfile, _auth=Depends(require_auth)):
    """What every agent may know about the business. Not a place for secrets."""
    name, about = (b.name or "").strip()[:120], (b.about or "").strip()[:4000]
    with closing(get_db()) as con:
        con.execute("INSERT INTO business_profile(id, name, about, updated_at) VALUES(1,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET name=excluded.name, about=excluded.about, "
                    "updated_at=excluded.updated_at", (name, about, _now().isoformat()))
        con.commit()
    return {"ok": True, "name": name, "about": about}


@app.get("/automations/requests")
def workflow_requests(_auth=Depends(require_auth)):
    with closing(get_db()) as con:
        rows = con.execute("SELECT id, workflow_id, workflow_name, summary, requested_by, status, created_at, "
                           "decided_at FROM workflow_requests ORDER BY id DESC LIMIT 40").fetchall()
    keys = ("id", "workflow_id", "workflow_name", "summary", "requested_by", "status", "created_at", "decided_at")
    items = [dict(zip(keys, r)) for r in rows]
    return {"pending": [i for i in items if i["status"] == "pending"],
            "recent": [i for i in items if i["status"] != "pending"][:10]}


def _decide_request(rid, approve):
    with closing(get_db()) as con:
        row = con.execute("SELECT workflow_id, status FROM workflow_requests WHERE id=?", (rid,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Request not found.")
    if row[1] != "pending":
        raise HTTPException(status_code=400, detail="That request was already decided.")
    if approve:
        if not re.match(r"^[A-Za-z0-9_-]{1,64}$", str(row[0])):
            raise HTTPException(status_code=400, detail="Bad workflow id.")
        try:
            _n8n_send("POST", "/api/v1/workflows/" + str(row[0]) + "/activate", {})
        except ToolError as e:
            raise HTTPException(status_code=400, detail="n8n could not activate it: " + str(e))
    with closing(get_db()) as con:
        con.execute("UPDATE workflow_requests SET status=?, decided_at=? WHERE id=?",
                    ("approved" if approve else "declined", _now().isoformat(), rid))
        con.commit()
    return {"ok": True, "status": "approved" if approve else "declined"}


@app.post("/automations/requests/{rid}/approve")
def approve_workflow_request(rid: int, _auth=Depends(require_auth)):
    """Owner approval: this is the only path that switches an agent-built workflow on."""
    return _decide_request(rid, True)


@app.post("/automations/requests/{rid}/decline")
def decline_workflow_request(rid: int, _auth=Depends(require_auth)):
    return _decide_request(rid, False)


@app.exception_handler(HTTPException)
def _http_exc(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
