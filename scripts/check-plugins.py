#!/usr/bin/env python3
"""Every dashboard page must be complete, or Hermes silently leaves it out of the menu.

Checks, for each folder in plugins/:
  - plugin.yaml and __init__.py exist (without them Hermes does not load the plugin)
  - dashboard/manifest.json exists, and the entry and css files it names exist
  - it is listed in scripts/enable-plugins.sh and scripts/sync-branding.sh
  - its page address is unique and is not one Hermes already uses for a built-in page
"""
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
# Addresses of Hermes' own pages (web/src/App.tsx in the pinned version).
HERMES = {"/", "/chat", "/sessions", "/analytics", "/models", "/logs", "/cron", "/skills", "/profiles", "/config", "/env",
          "/docs", "/files", "/kanban", "/achievements", "/channels", "/pairing", "/mcp", "/plugins", "/webhooks", "/system"}
bad, seen = [], {}
enable = open(os.path.join(ROOT, "scripts", "enable-plugins.sh")).read()
sync = open(os.path.join(ROOT, "scripts", "sync-branding.sh")).read()
for name in sorted(os.listdir(os.path.join(ROOT, "plugins"))):
    d = os.path.join(ROOT, "plugins", name)
    if not os.path.isdir(d):
        continue
    for f in ("plugin.yaml", "__init__.py", os.path.join("dashboard", "manifest.json")):
        if not os.path.isfile(os.path.join(d, f)):
            bad.append("%s: missing %s" % (name, f))
    mf = os.path.join(d, "dashboard", "manifest.json")
    if os.path.isfile(mf):
        m = json.load(open(mf))
        if m.get("name") != name:
            bad.append("%s: manifest name is %r" % (name, m.get("name")))
        for k in ("entry", "css"):
            if m.get(k) and not os.path.isfile(os.path.join(d, "dashboard", m[k])):
                bad.append("%s: %s file %s does not exist" % (name, k, m[k]))
        path = (m.get("tab") or {}).get("path")
        if path:
            if path in seen:
                bad.append("%s: address %s is already used by %s" % (name, path, seen[path]))
            if path in HERMES and not (m.get("tab") or {}).get("override"):
                bad.append("%s: address %s belongs to a built-in Hermes page" % (name, path))
            seen[path] = name
    for label, text in (("enable-plugins.sh", enable), ("sync-branding.sh", sync)):
        if not re.search(r"\b%s\b" % re.escape(name), text):
            bad.append("%s: not listed in scripts/%s" % (name, label))
if bad:
    print("\n".join(bad))
    sys.exit(1)
print("plugins ok: %d" % len(seen))
