"""Point Hermes at the Agent OS chat tools (connectors' MCP endpoint).

Run by scripts/sync-chat-tools.sh inside the connectors image with the Hermes
data dir mounted at /hermes. Adds/refreshes one `mcp_servers.agent_os` entry in
the default profile's config.yaml (all tools) and, for automation agents, in
their profile config (n8n tools only). Leaves every other key alone, keeps the
file's owner and mode, backs the file up once before the first change, and does
nothing when the entry is already correct.
"""
import os
import shutil
import sys

import yaml

HOME = "/hermes"
TOKEN = os.environ.get("CHAT_TOOLS_TOKEN", "").strip()
BASE = os.environ.get("CHAT_TOOLS_URL", "http://connectors:8000/mcp").rstrip("/")
EXTRA = [p.strip().lower() for p in os.environ.get("N8N_TOOLS_PROFILES", "").split(",") if p.strip()]


def apply(path, url):
    if not os.path.isfile(path):
        return "missing"
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    try:
        cfg = yaml.safe_load(raw) or {}
    except Exception as e:
        return "skipped (could not parse: %s)" % str(e)[:80]
    if not isinstance(cfg, dict):
        return "skipped (unexpected format)"
    servers = cfg.get("mcp_servers")
    if not isinstance(servers, dict):
        servers = {}
    want = {"url": url, "headers": {"Authorization": "Bearer " + TOKEN},
            "timeout": 60, "connect_timeout": 15}
    if servers.get("agent_os") == want:
        return "ok (unchanged)"
    servers["agent_os"] = want
    cfg["mcp_servers"] = servers
    st = os.stat(path)
    bak = path + ".pre-agent-os-tools"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        os.chown(bak, st.st_uid, st.st_gid)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False, allow_unicode=True)
    os.chmod(tmp, st.st_mode & 0o777)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, path)
    return "updated"


def main():
    if not TOKEN:
        print("CHAT_TOOLS_TOKEN is not set; chat tools not configured.")
        return 1
    main_cfg = os.path.join(HOME, "config.yaml")
    if not os.path.isfile(main_cfg):
        # Fresh install before Hermes has written its config: start one.
        with open(main_cfg, "w", encoding="utf-8") as f:
            f.write("{}\n")
        ref = os.stat(HOME)
        os.chown(main_cfg, ref.st_uid, ref.st_gid)
        os.chmod(main_cfg, 0o600)
    print("chat (default profile): " + apply(main_cfg, BASE))
    pdir = os.path.join(HOME, "profiles")
    if os.path.isdir(pdir):
        for name in sorted(os.listdir(pdir)):
            low = name.lower()
            if "automation" in low or "n8n" in low or low in EXTRA:
                print("agent profile %s: %s" % (name, apply(os.path.join(pdir, name, "config.yaml"), BASE + "/agent")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
