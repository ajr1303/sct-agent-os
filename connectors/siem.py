"""Security events: the dashboard's side of the optional built-in SIEM.

The SIEM itself is Wazuh, set up beside Agent OS by scripts/siem.sh (the host does that;
this service cannot start containers). This module only:

  - passes "turn on" / "turn off" to the host through a request file, like updates do
  - reports how the set-up is going (data/backup/siem-state.json)
  - reads alerts from Wazuh's indexer and the list of reporting computers from its API,
    with the connection details scripts/siem.sh leaves in data/backup/siem-conn.json

It never writes to the SIEM. Kept apart from app.py and added with mount().
"""
import json
import os
import re
import time

import httpx
from dateutil import parser as dtparse
from fastapi import Depends, HTTPException
from pydantic import BaseModel

_STALE_INSTALL = 45 * 60        # a set-up still "installing" after this died on the way
_REQUEST_STALE = 5 * 60         # the host looks every minute; longer means it is not looking
LEVELS = (("critical", 15, 99), ("high", 12, 14), ("medium", 7, 11), ("low", 0, 6))


def severity(level):
    for name, lo, _hi in LEVELS:
        if level >= lo:
            return name
    return "low"


class OnIn(BaseModel):
    console: bool = False


def mount(app, require_auth, cfg_dir=None):
    cfg_dir = cfg_dir or os.environ.get("AOS_BACKUP_CONFIG", "/backup-config")
    REQ = os.path.join(cfg_dir, "siem-request")
    STATE = os.path.join(cfg_dir, "siem-state.json")
    CONN = os.path.join(cfg_dir, "siem-conn.json")
    cache = {"conn": None, "conn_m": 0, "token": None, "token_at": 0}

    def _json(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                v = json.load(f)
            return v if isinstance(v, dict) else None
        except Exception:
            return None

    def _conn():
        try:
            m = os.path.getmtime(CONN)
        except OSError:
            cache["conn"] = None
            return None
        if cache["conn"] is None or m != cache["conn_m"]:
            cache["conn"], cache["conn_m"], cache["token"] = _json(CONN), m, None
        return cache["conn"]

    def status():
        st = _json(STATE) or {}
        state = st.get("state") if st.get("state") in ("installing", "running", "stopped", "failed") else "off"
        out = {"state": state, "step": str(st.get("step") or "")[:600], "version": str(st.get("version") or "")[:20],
               "console": bool(st.get("console")), "at": str(st.get("at") or "")[:40]}
        if state == "installing":
            try:
                age = time.time() - dtparse.parse(out["at"]).timestamp()
            except Exception:
                age = _STALE_INSTALL + 1
            if age > _STALE_INSTALL:
                out["state"], out["step"] = "failed", "Setting up stopped part way. Turn it on again to retry."
        try:
            waiting = int(time.time() - os.path.getmtime(REQ))
            out["requested"] = True
            # Nothing picked the request up: the host's every-minute job is not running.
            out["host_not_listening"] = waiting > _REQUEST_STALE
        except OSError:
            out["requested"] = False
        if out["state"] in ("running", "stopped"):
            c = _conn() or {}
            host = str(c.get("host") or "")
            v = out["version"] or "4.14.11"
            major = v.split(".")[0] + ".x"
            pw = str(c.get("enrol_password") or "")
            deb = "wazuh-agent_%s-1_amd64.deb" % v
            out["setup"] = {
                "host": host, "hostname": str(c.get("hostname") or ""),
                "syslog": {"port": 514, "protocol": "UDP"},
                "agent_ports": "1514 and 1515 (TCP)",
                "windows": ("Invoke-WebRequest -Uri https://packages.wazuh.com/%s/windows/wazuh-agent-%s-1.msi -OutFile $env:tmp\\wazuh-agent.msi; "
                            "msiexec.exe /i $env:tmp\\wazuh-agent.msi /q WAZUH_MANAGER='%s' WAZUH_REGISTRATION_PASSWORD='%s'" % (major, v, host, pw)),
                "windows_start": "NET START WazuhSvc",
                "linux": ("wget https://packages.wazuh.com/%s/apt/pool/main/w/wazuh-agent/%s && "
                          "sudo WAZUH_MANAGER='%s' WAZUH_REGISTRATION_PASSWORD='%s' dpkg -i ./%s && "
                          "sudo systemctl daemon-reload && sudo systemctl enable --now wazuh-agent" % (major, deb, host, pw, deb)),
                "console_port": (str(c.get("console_port") or "") or "5601") if out["console"] else ""}
        return out

    def _need_running():
        if status()["state"] != "running":
            raise HTTPException(status_code=409, detail="The SIEM is not running. Turn it on first.")
        c = _conn()
        if not c or not c.get("indexer_password"):
            raise HTTPException(status_code=503, detail="The SIEM's connection details are missing. Turn it on again to rewrite them.")
        return c

    def _down(e):
        return HTTPException(status_code=503, detail="The SIEM is not answering right now. It may still be starting; try again in a minute.")

    def _search(c, body):
        ca = os.path.join(cfg_dir, os.path.basename(str(c.get("ca") or "siem-ca.pem")))
        try:
            r = httpx.post(c["indexer_url"].rstrip("/") + "/wazuh-alerts-*/_search",
                           params={"ignore_unavailable": "true", "allow_no_indices": "true"}, json=body,
                           auth=(c.get("indexer_user") or "admin", c["indexer_password"]), verify=ca, timeout=20)
        except Exception as e:
            raise _down(e)
        if r.status_code == 404:
            return {"hits": {"hits": [], "total": {"value": 0}}, "aggregations": {}}
        if r.status_code in (401, 403):
            raise HTTPException(status_code=503, detail="The SIEM refused Agent OS's sign-in. Turn the SIEM off and on again.")
        if r.status_code >= 400:
            raise _down(r.status_code)
        return r.json()

    def _api(c, path, params=None):
        """Wazuh's manager API. Its certificate is one the manager makes for itself, which
        nothing can check, so it is not verified; the call never leaves Agent OS's own
        Docker network."""
        base = c["api_url"].rstrip("/")
        try:
            for attempt in (0, 1):
                if not cache["token"] or time.time() - cache["token_at"] > 600:
                    t = httpx.post(base + "/security/user/authenticate", auth=(c.get("api_user") or "wazuh-wui", c["api_password"]),
                                   verify=False, timeout=15)
                    if t.status_code >= 400:
                        raise HTTPException(status_code=503, detail="The SIEM refused Agent OS's sign-in. Turn the SIEM off and on again.")
                    cache["token"], cache["token_at"] = t.json()["data"]["token"], time.time()
                r = httpx.get(base + path, params=params or {}, headers={"Authorization": "Bearer " + cache["token"]},
                              verify=False, timeout=20)
                if r.status_code == 401 and attempt == 0:
                    cache["token"] = None
                    continue
                if r.status_code >= 400:
                    raise _down(r.status_code)
                return r.json()
        except HTTPException:
            raise
        except Exception as e:
            raise _down(e)

    def _filters(hours, min_level, agent, q):
        hours = max(1, min(int(hours or 24), 24 * 30))
        f = [{"range": {"timestamp": {"gte": "now-%dh" % hours}}}]
        if min_level:
            f.append({"range": {"rule.level": {"gte": max(0, min(int(min_level), 15))}}})
        agent = re.sub(r"[\x00-\x1f]", " ", str(agent or "")).strip()[:120]
        if agent:
            f.append({"bool": {"should": [{"term": {"agent.name": agent}}, {"term": {"agent.id": agent}},
                                           {"term": {"location": agent}}], "minimum_should_match": 1}})
        must = []
        q = re.sub(r"[\x00-\x1f]", " ", str(q or "")).strip()[:200]
        if q:
            # simple_query_string never throws on odd input; flags keep it to plain words and phrases.
            must.append({"simple_query_string": {"query": q, "default_operator": "and", "flags": "AND|OR|NOT|PHRASE|WHITESPACE",
                                                 "fields": ["rule.description", "full_log", "agent.name", "location", "data.srcip", "rule.groups"]}})
        return {"bool": {"filter": f, "must": must}}, hours

    def _alert(h):
        s = h.get("_source") or {}
        rule, ag, data = s.get("rule") or {}, s.get("agent") or {}, s.get("data") or {}
        level = int(rule.get("level") or 0)
        # Syslog from network gear arrives under the manager itself ("000"); the sender is in location.
        from_gear = str(ag.get("id") or "") == "000" and re.match(r"^\d+\.\d+\.\d+\.\d+", str(s.get("location") or ""))
        return {"id": str(h.get("_id") or ""), "time": s.get("timestamp"), "level": level, "severity": severity(level),
                "rule": str(rule.get("description") or "")[:300], "rule_id": str(rule.get("id") or ""),
                "groups": [str(g) for g in (rule.get("groups") or [])][:8],
                "source": str(s.get("location") if from_gear else (ag.get("name") or ""))[:120],
                "source_ip": str(ag.get("ip") or "")[:60], "kind": "network gear" if from_gear else "computer",
                "src_ip": str(data.get("srcip") or "")[:60], "user": str(data.get("dstuser") or data.get("srcuser") or "")[:80],
                "log": str(s.get("full_log") or "")[:1500]}

    def alerts(hours=24, min_level=7, agent="", q="", limit=100):
        c = _need_running()
        query, hours = _filters(hours, min_level, agent, q)
        limit = max(1, min(int(limit or 100), 500))
        # Totals ignore the level filter, so the four counters always show the whole picture.
        base, _ = _filters(hours, 0, agent, q)
        res = _search(c, {"size": limit, "sort": [{"timestamp": {"order": "desc"}}], "query": query, "track_total_hits": True,
                          "_source": ["timestamp", "rule.level", "rule.description", "rule.id", "rule.groups", "agent.id", "agent.name",
                                      "agent.ip", "location", "full_log", "data.srcip", "data.dstuser", "data.srcuser"]})
        agg = _search(c, {"size": 0, "query": base, "aggs": {"sev": {"range": {"field": "rule.level", "ranges": [
            {"key": name, "from": lo, "to": hi + 1} for name, lo, hi in LEVELS]}}}})
        buckets = ((agg.get("aggregations") or {}).get("sev") or {}).get("buckets") or []
        totals = {b.get("key"): int(b.get("doc_count") or 0) for b in buckets}
        total = (res.get("hits") or {}).get("total") or {}
        return {"alerts": [_alert(h) for h in (res.get("hits") or {}).get("hits") or []],
                "total": int(total.get("value") or 0) if isinstance(total, dict) else int(total or 0),
                "totals": {name: totals.get(name, 0) for name, _, _ in LEVELS}, "hours": hours}

    def sources():
        c = _need_running()
        data = (_api(c, "/agents", {"limit": 500, "select": "id,name,ip,status,os.name,version,lastKeepAlive", "sort": "+name"}).get("data") or {})
        comps = [{"id": a.get("id"), "name": a.get("name") or "", "ip": a.get("ip") or "", "status": a.get("status") or "",
                  "os": (a.get("os") or {}).get("name") or "", "version": a.get("version") or "", "last_seen": a.get("lastKeepAlive")}
                 for a in data.get("affected_items") or [] if a.get("id") != "000"]
        # Network gear has no agent: list who has sent syslog that raised an alert this week.
        res = _search(c, {"size": 0, "query": {"bool": {"filter": [{"range": {"timestamp": {"gte": "now-7d"}}}, {"term": {"agent.id": "000"}}]}},
                          "aggs": {"who": {"terms": {"field": "location", "size": 50},
                                           "aggs": {"last": {"max": {"field": "timestamp"}}}}}})
        gear = [{"address": b.get("key"), "alerts": int(b.get("doc_count") or 0), "last_seen": (b.get("last") or {}).get("value_as_string")}
                for b in ((res.get("aggregations") or {}).get("who") or {}).get("buckets") or []
                if re.match(r"^\d+\.\d+\.\d+\.\d+", str(b.get("key") or ""))]
        return {"computers": comps, "gear": gear}

    def _request(word):
        os.makedirs(cfg_dir, exist_ok=True)
        with open(REQ, "w", encoding="utf-8") as f:
            f.write(word + "\n")

    @app.get("/siem")
    def siem_status(_auth=Depends(require_auth)):
        return status()

    @app.post("/siem/on")
    def siem_on(b: OnIn, _auth=Depends(require_auth)):
        if status()["state"] == "installing":
            raise HTTPException(status_code=409, detail="The SIEM is already being set up.")
        _request("on console" if b.console else "on")
        return status()

    @app.post("/siem/off")
    def siem_off(_auth=Depends(require_auth)):
        st = status()
        if st["state"] == "installing":
            raise HTTPException(status_code=409, detail="The SIEM is being set up. Wait for that to finish first.")
        if st["state"] == "off":
            raise HTTPException(status_code=400, detail="The SIEM is not set up.")
        _request("off")
        return status()

    @app.get("/siem/alerts")
    def siem_alerts(hours: int = 24, min_level: int = 7, agent: str = "", q: str = "", limit: int = 100, _auth=Depends(require_auth)):
        return alerts(hours, min_level, agent, q, limit)

    @app.get("/siem/sources")
    def siem_sources(_auth=Depends(require_auth)):
        return sources()

    return {"status": status, "alerts": alerts, "sources": sources}
