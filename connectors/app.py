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
from dateutil import parser as dtparse
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
    try:
        data = _n8n_api("/api/v1/workflows", params={"limit": 100})
    except PermissionError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail="Could not reach n8n: " + str(e)[:140])
    wfs = data.get("data") or []
    out = [{"id": w.get("id"), "name": w.get("name") or "Workflow", "active": bool(w.get("active"))} for w in wfs]
    return {"count": len(out), "active": sum(1 for w in out if w["active"]), "workflows": out}


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
HERMES_API_KEY = os.environ.get("HERMES_API_KEY", "").strip()


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
        raise HTTPException(status_code=400, detail="Paperclip rejected that board API key. Copy a company board key from Paperclip › Settings.")
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

    adapter_config = {
        "apiBaseUrl": HERMES_API_URL,
        "apiKey": HERMES_API_KEY,
        "dangerouslyAllowInsecureRemoteHttp": True,  # http://hermes:8642 is internal, not loopback
        "sessionKeyStrategy": "issue",
    }
    if a.instructions.strip():
        adapter_config["instructions"] = a.instructions.strip()
    role = (a.role or "general").strip().lower()
    if role not in AGENT_ROLES:
        role = "general"
    body = {"name": name, "role": role, "adapterType": "hermes_gateway", "adapterConfig": adapter_config}

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
    return {"ok": True, "agent": {"id": data.get("id"), "name": data.get("name") or name}}


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
        "instructions": (ac.get("instructions") if isinstance(ac, dict) else "") or "",
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
        body["adapterConfig"] = {"instructions": a.instructions.strip()}
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
                          "role": a.get("role")} for a in items][:50]
    except Exception as e:
        out["errors"].append("agents: " + str(e)[:120])
    try:
        att = _pc_get("/api/companies/" + str(cid) + "/attention/summary")
        out["attention"] = att
    except Exception as e:
        out["errors"].append("attention: " + str(e)[:120])
    return out


@app.exception_handler(HTTPException)
def _http_exc(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})
