"""Store what scripts/agent-models.sh collected. Reads JSON lines on stdin
(one per agent: agent_id, model, provider, hermes_version, ok, error, checked_at)
and replaces the agent_models table. Model names only; no keys ever arrive here."""
import sys
import json
from contextlib import closing

from app import get_db


def main():
    rows = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        aid = str(d.get("agent_id") or "")[:80]
        if not aid:
            continue
        cut = lambda v, n: (str(v)[:n] if v not in (None, "") else None)
        rows.append((aid, cut(d.get("model"), 120), cut(d.get("provider"), 120), cut(d.get("hermes_version"), 40),
                     1 if d.get("ok") else 0, cut(d.get("error"), 200), cut(d.get("checked_at"), 40)))
    with closing(get_db()) as con:
        if rows:  # keep the last good picture if a run produced nothing at all
            con.execute("DELETE FROM agent_models")
            con.executemany("INSERT OR REPLACE INTO agent_models VALUES (?,?,?,?,?,?,?)", rows)
            con.commit()
    print("stored model info for %d agent(s)" % len(rows))


if __name__ == "__main__":
    main()
