"""Clients: one record per business you look after, with its contact, plan, equipment,
notes and documents in one place.

Kept apart from app.py and added to it with mount(). It owns its own tables and only
reads the devices and computers that My devices already holds; it changes nothing about
how apps are connected.

  clients               the record (contact, plan, free text, offboarding progress)
  client_links          which scanned gear, sites and reporting computers belong to a client
  client_equipment      things typed in by hand (a printer, a firewall nothing scans yet)
  client_notes          a dated log
  client_docs / _blobs  uploaded documents
"""
import json
import re
import sqlite3
from contextlib import closing
from urllib.parse import quote

from fastapi import Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

DOC_MAX = 20 * 1024 * 1024
DOCS_PER_CLIENT = 200
DOC_STORE_MAX = 1024 * 1024 * 1024
CLIENTS_MAX = 500

# What has to happen when a client leaves. Agent OS can only do its own side; the rest
# is on the client's systems, so each step is ticked off by the person who did it.
OFFBOARD = [
    ("console", "Remove your admin account from the client's network console",
     "In their UniFi, Meraki or other console, remove the account you were invited with. They stay the owner."),
    ("keys", "Delete the API keys made for you on their systems",
     "Any key created so Agent OS or your tools could read their network or apps."),
    ("remote", "Remove remote access",
     "VPN or mesh shares, remote-control tools, saved logins and port forwards that let you in."),
    ("reporters", "Uninstall the Agent OS reporter from their computers",
     "Then remove those computers on My devices so their reports are refused."),
    ("handover", "Hand over their documentation and passwords",
     "Network diagram, admin logins they own, licence keys, anything they need to carry on without you."),
    ("billing", "Close out the plan",
     "Send the final invoice and cancel anything you pay for on their behalf."),
]
_OFF_KEYS = [k for k, _, _ in OFFBOARD]

_FIELDS = {"name": 80, "contact_name": 80, "contact_email": 160, "contact_phone": 40, "address": 240, "website": 160,
           "plan": 80, "plan_price": 40, "plan_renews": 10, "plan_details": 4000, "about": 8000}


class ClientIn(BaseModel):
    name: str | None = None
    contact_name: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None
    address: str | None = None
    website: str | None = None
    plan: str | None = None
    plan_price: str | None = None
    plan_renews: str | None = None
    plan_details: str | None = None
    about: str | None = None
    status: str | None = None


class LinkIn(BaseModel):
    kind: str
    ref: str


class EquipmentIn(BaseModel):
    name: str = ""
    kind: str = ""
    detail: str = ""


class NoteIn(BaseModel):
    text: str = ""


class OffboardIn(BaseModel):
    step: str
    done: bool = True


def _clean(v, limit, multiline=False):
    v = str(v or "")
    v = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", v) if multiline else re.sub(r"[\x00-\x1f\x7f]", " ", v)
    return v.strip()[:limit]


def _file_name(v):
    v = _clean(v, 200).replace("\\", "/").split("/")[-1].strip()
    return v[:120]


def mount(app, get_db, require_auth, now, device_rows, computers):
    """Add the /clients routes to the app. device_rows() and computers() are My devices' own
    readers, so this page always shows what that page shows. Returns the helpers the
    agents' tool uses."""
    ready = {"ok": False}

    def db():
        con = get_db()
        if not ready["ok"]:
            con.executescript("""
                CREATE TABLE IF NOT EXISTS clients (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    contact_name TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '',
                    contact_phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
                    website TEXT NOT NULL DEFAULT '',
                    plan TEXT NOT NULL DEFAULT '', plan_price TEXT NOT NULL DEFAULT '',
                    plan_renews TEXT NOT NULL DEFAULT '', plan_details TEXT NOT NULL DEFAULT '',
                    about TEXT NOT NULL DEFAULT '',
                    offboard TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS client_links (
                    client_id INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, added_at TEXT NOT NULL,
                    PRIMARY KEY (kind, ref)
                );
                CREATE TABLE IF NOT EXISTS client_equipment (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
                    name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS client_notes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
                    text TEXT NOT NULL, added_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS client_docs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL,
                    name TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS client_doc_blobs (doc_id INTEGER PRIMARY KEY, data BLOB NOT NULL);
                CREATE INDEX IF NOT EXISTS client_links_cid ON client_links(client_id);
                CREATE INDEX IF NOT EXISTS client_notes_cid ON client_notes(client_id);
                CREATE INDEX IF NOT EXISTS client_docs_cid ON client_docs(client_id);
            """)
            con.commit()
            ready["ok"] = True
        return con

    # ---- what My devices knows, shaped for this page -----------------------------------
    def _gear():
        """Network gear only (gateways, switches, access points), not everything plugged in."""
        out = []
        for r in device_rows():
            if r.get("kind") != "network":
                continue
            src = r.get("source") or ""
            out.append({"ref": "%s:%s" % (src, r.get("ext_id") or ""), "site": "%s:%s" % (src, r.get("site_id") or ""),
                        "name": r.get("name") or r.get("model") or "Device", "model": r.get("model") or "",
                        "ip": r.get("ip") or "", "state": r.get("state") or "", "firmware": r.get("firmware") or "",
                        "update_waiting": bool(r.get("updatable"))})
        return out

    def _comps():
        return [{"ref": str(c["id"]), "name": c["name"], "os_name": c.get("os_name") or "", "host": c.get("host") or "",
                 "reporting": bool(c.get("reporting")), "last_seen": c.get("last_seen"),
                 "problems": list(c.get("problems") or [])} for c in computers() if not c.get("pending")]

    def _owners(con):
        """(kind, ref) -> client id, for every link."""
        return {(k, r): cid for cid, k, r in con.execute("SELECT client_id, kind, ref FROM client_links")}

    def _gear_owner(owners, g):
        # A device linked by itself wins over the site it sits in.
        return owners.get(("device", g["ref"])) or owners.get(("site", g["site"]))

    def _equipment_for(cid, owners, gear, comps):
        mine_g = [g for g in gear if _gear_owner(owners, g) == cid]
        mine_c = [c for c in comps if owners.get(("computer", c["ref"])) == cid]
        return mine_g, mine_c

    def _trouble(mine_g, mine_c):
        return (sum(1 for g in mine_g if g["state"] != "ONLINE") +
                sum(1 for c in mine_c if c["problems"] or (c["last_seen"] and not c["reporting"])))

    _KEYS = ("id", "name", "status", "contact_name", "contact_email", "contact_phone", "address", "website", "plan",
             "plan_price", "plan_renews", "plan_details", "about", "offboard", "created_at", "updated_at")

    def _row(con, cid):
        r = con.execute("SELECT %s FROM clients WHERE id=?" % ", ".join(_KEYS), (cid,)).fetchone()
        return dict(zip(_KEYS, r)) if r else None

    def _need(con, cid):
        c = _row(con, cid)
        if not c:
            raise HTTPException(status_code=404, detail="That client no longer exists.")
        return c

    def _touch(con, cid):
        con.execute("UPDATE clients SET updated_at=? WHERE id=?", (now().isoformat(), cid))

    def listing(message=None):
        gear, comps = _gear(), _comps()
        with closing(db()) as con:
            rows = [dict(zip(_KEYS, r)) for r in con.execute(
                "SELECT %s FROM clients ORDER BY (status='active') DESC, name COLLATE NOCASE" % ", ".join(_KEYS))]
            owners = _owners(con)
            counts = {}
            for table in ("client_equipment", "client_notes", "client_docs"):
                counts[table] = dict(con.execute("SELECT client_id, count(*) FROM %s GROUP BY client_id" % table).fetchall())
        out = []
        for c in rows:
            g, k = _equipment_for(c["id"], owners, gear, comps)
            out.append({"id": c["id"], "name": c["name"], "status": c["status"], "plan": c["plan"],
                        "contact_name": c["contact_name"], "contact_email": c["contact_email"],
                        "equipment": len(g) + len(k) + counts["client_equipment"].get(c["id"], 0),
                        "trouble": _trouble(g, k) if c["status"] == "active" else 0,
                        "notes": counts["client_notes"].get(c["id"], 0), "docs": counts["client_docs"].get(c["id"], 0),
                        "updated_at": c["updated_at"]})
        v = {"clients": out}
        if message:
            v["message"] = message
        return v

    def detail(cid, message=None):
        gear, comps = _gear(), _comps()
        with closing(db()) as con:
            c = _need(con, cid)
            owners = _owners(con)
            names = dict(con.execute("SELECT id, name FROM clients").fetchall())
            links = con.execute("SELECT kind, ref FROM client_links WHERE client_id=?", (cid,)).fetchall()
            c["equipment"] = [dict(zip(("id", "name", "kind", "detail", "created_at"), r)) for r in con.execute(
                "SELECT id, name, kind, detail, created_at FROM client_equipment WHERE client_id=? ORDER BY name COLLATE NOCASE", (cid,))]
            c["notes"] = [dict(zip(("id", "text", "added_by", "created_at"), r)) for r in con.execute(
                "SELECT id, text, added_by, created_at FROM client_notes WHERE client_id=? ORDER BY id DESC LIMIT 300", (cid,))]
            c["docs"] = [dict(zip(("id", "name", "mime", "size", "created_at"), r)) for r in con.execute(
                "SELECT id, name, mime, size, created_at FROM client_docs WHERE client_id=? ORDER BY id DESC", (cid,))]
        try:
            done = json.loads(c.pop("offboard") or "{}")
        except ValueError:
            done = {}
        c["offboard"] = [{"key": k, "title": t, "help": hlp, "done_at": done.get(k)} for k, t, hlp in OFFBOARD]
        mine_g, mine_c = _equipment_for(cid, owners, gear, comps)
        sites = {r for k, r in links if k == "site"}
        for g in mine_g:
            g["via_site"] = ("device", g["ref"]) not in owners and g["site"] in sites
        c["gear"], c["computers"] = mine_g, mine_c
        c["sites"] = sorted(sites)
        c["trouble"] = _trouble(mine_g, mine_c) if c["status"] == "active" else 0
        # Links whose gear or computer is gone from My devices (removed, or not scanned in 30 days).
        live = {("device", g["ref"]) for g in gear} | {("computer", k["ref"]) for k in comps} | {("site", g["site"]) for g in gear}
        c["missing"] = [{"kind": k, "ref": r} for k, r in links if (k, r) not in live]
        # What can still be linked, with who has it now so a move is a deliberate choice.
        by_site = {}
        for g in gear:
            by_site.setdefault(g["site"], []).append(g)
        c["available"] = {
            "sites": [{"ref": s, "count": len(gs), "names": [g["name"] for g in gs[:4]],
                       "client": names.get(owners.get(("site", s))) if owners.get(("site", s)) not in (None, cid) else None}
                      for s, gs in sorted(by_site.items()) if owners.get(("site", s)) != cid],
            "gear": [dict(g, client=names.get(_gear_owner(owners, g))) for g in gear if _gear_owner(owners, g) != cid],
            "computers": [dict(k, client=names.get(owners.get(("computer", k["ref"])))) for k in comps
                          if owners.get(("computer", k["ref"])) != cid]}
        if message:
            c["message"] = message
        return c

    def _fields(b, creating):
        out = {}
        for k, limit in _FIELDS.items():
            v = getattr(b, k)
            if v is None and not (creating and k == "name"):
                continue
            out[k] = _clean(v, limit, multiline=k in ("plan_details", "about", "address"))
        if "name" in out:
            out["name"] = re.sub(r"\s+", " ", out["name"])
            if not out["name"]:
                raise HTTPException(status_code=400, detail="Give the client a name.")
        if out.get("plan_renews") and not re.match(r"^\d{4}-\d{2}-\d{2}$", out["plan_renews"]):
            raise HTTPException(status_code=400, detail="The renewal date must be a date, like 2027-01-31.")
        if out.get("contact_email") and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", out["contact_email"]):
            raise HTTPException(status_code=400, detail="That email address does not look right.")
        if out.get("website") and not re.match(r"^https?://", out["website"], re.I):
            out["website"] = "https://" + out["website"]
        if b.status is not None:
            if b.status not in ("active", "archived"):
                raise HTTPException(status_code=400, detail="Status must be active or archived.")
            out["status"] = b.status
        return out

    # ---- routes ------------------------------------------------------------------------
    @app.get("/clients")
    def clients_list(_auth=Depends(require_auth)):
        return listing()

    @app.post("/clients")
    def clients_create(b: ClientIn, _auth=Depends(require_auth)):
        f = _fields(b, True)
        f.pop("status", None)
        t = now().isoformat()
        with closing(db()) as con:
            if con.execute("SELECT count(*) FROM clients").fetchone()[0] >= CLIENTS_MAX:
                raise HTTPException(status_code=400, detail="That is a lot of clients. Delete some you no longer need first.")
            if con.execute("SELECT 1 FROM clients WHERE name=? COLLATE NOCASE", (f["name"],)).fetchone():
                raise HTTPException(status_code=400, detail="You already have a client with that name.")
            cols = list(f) + ["created_at", "updated_at"]
            cid = con.execute("INSERT INTO clients(%s) VALUES(%s)" % (", ".join(cols), ",".join("?" * len(cols))),
                              [f[k] for k in f] + [t, t]).lastrowid
            con.commit()
        return detail(cid)

    @app.get("/clients/{cid}")
    def clients_get(cid: int, _auth=Depends(require_auth)):
        return detail(cid)

    @app.patch("/clients/{cid}")
    def clients_update(cid: int, b: ClientIn, _auth=Depends(require_auth)):
        f = _fields(b, False)
        with closing(db()) as con:
            _need(con, cid)
            if "name" in f and con.execute("SELECT 1 FROM clients WHERE name=? COLLATE NOCASE AND id<>?", (f["name"], cid)).fetchone():
                raise HTTPException(status_code=400, detail="You already have a client with that name.")
            for k, v in f.items():      # keys come from _FIELDS and "status" only
                con.execute("UPDATE clients SET %s=? WHERE id=?" % k, (v, cid))
            _touch(con, cid)
            con.commit()
        msg = None
        if f.get("status") == "archived":
            msg = "Archived. The record, notes and documents are kept, and nothing was changed on their systems."
        elif f.get("status") == "active":
            msg = "Back to active."
        return detail(cid, msg)

    @app.delete("/clients/{cid}")
    def clients_delete(cid: int, _auth=Depends(require_auth)):
        with closing(db()) as con:
            con.execute("DELETE FROM client_doc_blobs WHERE doc_id IN (SELECT id FROM client_docs WHERE client_id=?)", (cid,))
            for table in ("client_docs", "client_notes", "client_equipment", "client_links"):
                con.execute("DELETE FROM %s WHERE client_id=?" % table, (cid,))
            con.execute("DELETE FROM clients WHERE id=?", (cid,))
            con.commit()
        return listing("The client was deleted. Their devices stay on My devices.")

    @app.post("/clients/{cid}/links")
    def clients_link(cid: int, b: LinkIn, _auth=Depends(require_auth)):
        ref = _clean(b.ref, 300)
        if b.kind not in ("site", "device", "computer") or not ref:
            raise HTTPException(status_code=400, detail="Choose a site, a device or a computer to link.")
        gear = _gear()
        known = ({g["ref"] for g in gear} if b.kind == "device" else {g["site"] for g in gear} if b.kind == "site"
                 else {c["ref"] for c in _comps()})
        if ref not in known:
            raise HTTPException(status_code=404, detail="That is no longer on My devices. Reload and try again.")
        with closing(db()) as con:
            _need(con, cid)
            # One owner each: linking here takes it from whichever client had it.
            con.execute("INSERT INTO client_links(client_id, kind, ref, added_at) VALUES(?,?,?,?) "
                        "ON CONFLICT(kind, ref) DO UPDATE SET client_id=excluded.client_id, added_at=excluded.added_at",
                        (cid, b.kind, ref, now().isoformat()))
            if b.kind == "site":        # the whole site is theirs now; single links into it are redundant
                refs = [g["ref"] for g in gear if g["site"] == ref]
                con.executemany("DELETE FROM client_links WHERE kind='device' AND ref=? AND client_id=?", [(r, cid) for r in refs])
            _touch(con, cid)
            con.commit()
        return detail(cid)

    @app.post("/clients/{cid}/unlink")
    def clients_unlink(cid: int, b: LinkIn, _auth=Depends(require_auth)):
        with closing(db()) as con:
            _need(con, cid)
            con.execute("DELETE FROM client_links WHERE client_id=? AND kind=? AND ref=?", (cid, b.kind, _clean(b.ref, 300)))
            _touch(con, cid)
            con.commit()
        return detail(cid)

    @app.post("/clients/{cid}/equipment")
    def clients_equipment_add(cid: int, b: EquipmentIn, _auth=Depends(require_auth)):
        name = _clean(b.name, 120)
        if not name:
            raise HTTPException(status_code=400, detail="Give the equipment a name.")
        with closing(db()) as con:
            _need(con, cid)
            if con.execute("SELECT count(*) FROM client_equipment WHERE client_id=?", (cid,)).fetchone()[0] >= 500:
                raise HTTPException(status_code=400, detail="This client's equipment list is full.")
            con.execute("INSERT INTO client_equipment(client_id, name, kind, detail, created_at) VALUES(?,?,?,?,?)",
                        (cid, name, _clean(b.kind, 60), _clean(b.detail, 600), now().isoformat()))
            _touch(con, cid)
            con.commit()
        return detail(cid)

    @app.delete("/clients/{cid}/equipment/{eid}")
    def clients_equipment_delete(cid: int, eid: int, _auth=Depends(require_auth)):
        with closing(db()) as con:
            con.execute("DELETE FROM client_equipment WHERE id=? AND client_id=?", (eid, cid))
            con.commit()
        return detail(cid)

    @app.post("/clients/{cid}/notes")
    def clients_note_add(cid: int, b: NoteIn, _auth=Depends(require_auth)):
        text = _clean(b.text, 8000, multiline=True)
        if not text:
            raise HTTPException(status_code=400, detail="Write the note first.")
        add_note(cid, text, "You")
        return detail(cid)

    @app.delete("/clients/{cid}/notes/{nid}")
    def clients_note_delete(cid: int, nid: int, _auth=Depends(require_auth)):
        with closing(db()) as con:
            con.execute("DELETE FROM client_notes WHERE id=? AND client_id=?", (nid, cid))
            con.commit()
        return detail(cid)

    @app.post("/clients/{cid}/docs")
    async def clients_doc_upload(cid: int, request: Request, name: str = "", _auth=Depends(require_auth)):
        """One file, sent as the request body, with its name in the address."""
        too_big = HTTPException(status_code=413, detail="That file is too big. The limit is %d MB a file." % (DOC_MAX // 1048576))
        try:
            declared = int(request.headers.get("content-length") or 0)
        except ValueError:
            declared = 0
        if declared > DOC_MAX:
            raise too_big
        buf = bytearray()
        async for chunk in request.stream():
            buf.extend(chunk)
            if len(buf) > DOC_MAX:
                raise too_big
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(_doc_save, cid, name, bytes(buf), request.headers.get("content-type") or "")

    def _doc_save(cid, name, data, mime):
        name = _file_name(name)
        if not name:
            raise HTTPException(status_code=400, detail="Give the file a name.")
        if not data:
            raise HTTPException(status_code=400, detail="That file is empty.")
        t = now().isoformat()
        with closing(db()) as con:
            _need(con, cid)
            old = con.execute("SELECT id FROM client_docs WHERE client_id=? AND name=? COLLATE NOCASE", (cid, name)).fetchone()
            if not old and con.execute("SELECT count(*) FROM client_docs WHERE client_id=?", (cid,)).fetchone()[0] >= DOCS_PER_CLIENT:
                raise HTTPException(status_code=400, detail="This client has %d documents already. Remove some first." % DOCS_PER_CLIENT)
            if con.execute("SELECT coalesce(sum(size),0) FROM client_docs").fetchone()[0] + len(data) > DOC_STORE_MAX:
                raise HTTPException(status_code=400, detail="Client document storage is full. Remove files you no longer need.")
            if old:                     # same name again replaces the earlier copy
                did = old[0]
                con.execute("UPDATE client_docs SET mime=?, size=?, created_at=? WHERE id=?", (mime[:120], len(data), t, did))
                con.execute("DELETE FROM client_doc_blobs WHERE doc_id=?", (did,))
            else:
                did = con.execute("INSERT INTO client_docs(client_id, name, mime, size, created_at) VALUES(?,?,?,?,?)",
                                  (cid, name, mime[:120], len(data), t)).lastrowid
            con.execute("INSERT INTO client_doc_blobs(doc_id, data) VALUES(?,?)", (did, sqlite3.Binary(data)))
            _touch(con, cid)
            con.commit()
        return detail(cid)

    @app.get("/clients/{cid}/docs/{did}")
    def clients_doc_download(cid: int, did: int, _auth=Depends(require_auth)):
        with closing(db()) as con:
            r = con.execute("SELECT d.name, b.data FROM client_docs d JOIN client_doc_blobs b ON b.doc_id=d.id "
                            "WHERE d.id=? AND d.client_id=?", (did, cid)).fetchone()
        if not r:
            raise HTTPException(status_code=404, detail="That document is no longer there.")
        # Always a download, never shown in the page: an uploaded file must not be able to
        # run as part of the dashboard.
        return Response(content=bytes(r[1]), media_type="application/octet-stream",
                        headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(r[0], safe=""),
                                 "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
                                 "Cache-Control": "no-store"})

    @app.delete("/clients/{cid}/docs/{did}")
    def clients_doc_delete(cid: int, did: int, _auth=Depends(require_auth)):
        with closing(db()) as con:
            if con.execute("SELECT 1 FROM client_docs WHERE id=? AND client_id=?", (did, cid)).fetchone():
                con.execute("DELETE FROM client_doc_blobs WHERE doc_id=?", (did,))
                con.execute("DELETE FROM client_docs WHERE id=?", (did,))
                con.commit()
        return detail(cid)

    @app.post("/clients/{cid}/offboard")
    def clients_offboard(cid: int, b: OffboardIn, _auth=Depends(require_auth)):
        if b.step not in _OFF_KEYS:
            raise HTTPException(status_code=400, detail="Unknown step.")
        with closing(db()) as con:
            c = _need(con, cid)
            try:
                done = json.loads(c["offboard"] or "{}")
            except ValueError:
                done = {}
            if b.done:
                done.setdefault(b.step, now().isoformat())
            else:
                done.pop(b.step, None)
            con.execute("UPDATE clients SET offboard=? WHERE id=?", (json.dumps(done), cid))
            _touch(con, cid)
            con.commit()
        return detail(cid)

    # ---- for the agents' tool ----------------------------------------------------------
    def add_note(cid, text, who):
        with closing(db()) as con:
            _need(con, cid)
            con.execute("INSERT INTO client_notes(client_id, text, added_by, created_at) VALUES(?,?,?,?)",
                        (cid, text, _clean(who, 80), now().isoformat()))
            _touch(con, cid)
            con.commit()

    def find(want):
        """Client ids matching an id or part of a name, best first."""
        want = str(want or "").strip()
        with closing(db()) as con:
            rows = con.execute("SELECT id, name FROM clients ORDER BY (status='active') DESC, name COLLATE NOCASE").fetchall()
        if want.isdigit():
            hit = [r for r in rows if r[0] == int(want)]
            if hit:
                return hit
        low = want.lower()
        exact = [r for r in rows if r[1].lower() == low]
        return exact or [r for r in rows if low and low in r[1].lower()]

    return {"listing": listing, "detail": detail, "find": find, "add_note": add_note}
