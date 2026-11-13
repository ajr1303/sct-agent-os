#!/usr/bin/env python3
"""Prepare exported n8n workflow files for import into a fresh n8n.

  n8n-prepare-import.py <source-dir> <output-dir>

For every *.json workflow in <source-dir> it writes a cleaned copy to <output-dir>:
  - switched OFF (active = false), so nothing starts running on import;
  - with fields from the old server removed (owner/project links, tag links,
    published-version pointers, backup metadata) that would not match the new one.
Workflow ids, steps, connections, settings, pinned and static data are kept, so
workflows that call each other still line up. Source files are never modified.
"""
import json
import os
import sys

KEEP = ("id", "name", "nodes", "connections", "settings", "staticData", "pinData", "meta", "versionId", "isArchived")


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    ok = was_active = archived = skipped = 0
    seen = set()
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if not name.endswith(".json") or not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print("  skipped %s (not valid JSON: %s)" % (name, str(e)[:60]))
            skipped += 1
            continue
        items = data if isinstance(data, list) else [data]
        for w in items:
            if not isinstance(w, dict) or not isinstance(w.get("nodes"), list) or not isinstance(w.get("connections"), dict):
                print("  skipped %s (not a workflow export)" % name)
                skipped += 1
                continue
            wid = str(w.get("id") or "")
            if not wid or wid in seen or not all(c.isalnum() or c in "-_" for c in wid):
                print("  skipped %s (missing, unsafe or repeated id)" % name)
                skipped += 1
                continue
            seen.add(wid)
            was_active += 1 if w.get("active") else 0
            archived += 1 if w.get("isArchived") else 0
            clean = {k: w[k] for k in KEEP if k in w}
            clean["name"] = str(clean.get("name") or "Imported workflow")[:128]
            clean["active"] = False
            if not isinstance(clean.get("settings"), dict):
                clean["settings"] = {}
            with open(os.path.join(out, wid + ".json"), "w", encoding="utf-8") as f:
                json.dump(clean, f)
            ok += 1
    print("Prepared %d workflow(s): all switched off (%d were on in the backup, %d archived). Skipped %d."
          % (ok, was_active, archived, skipped))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
