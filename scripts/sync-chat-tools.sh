#!/usr/bin/env bash
# Give the Hermes chat agent its business tools: writes the `agent_os` MCP server
# entry into the Hermes config (see connectors/mcp_config.py) and installs the
# routing skill. Idempotent; called by install.sh and update.sh BEFORE Hermes is
# (re)started so the gateway loads the new config.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
warn() { echo "  ! $*" >&2; }

H="${HERMES_HOME_DIR:-./data/hermes}"
[ -f .env ] && _h=$(sed -n 's/^HERMES_HOME_DIR=//p' .env | tail -n1) && [ -n "${_h:-}" ] && H="$_h"
mkdir -p "$H"
H_ABS=$(cd "$H" && pwd)

# Routing skill -> the default profile's skills dir.
if [ -d skills/agent-os ]; then
  mkdir -p "$H/skills/agent-os"
  cp -r skills/agent-os/. "$H/skills/agent-os/"
  find "$H/skills/agent-os" -type d -exec chmod 755 {} +
  find "$H/skills/agent-os" -type f -exec chmod 644 {} +
  # Match the owner of the Hermes data dir so the agent can read/manage it.
  chown -R --reference="$H" "$H/skills/agent-os" 2>/dev/null || true
fi

docker compose run --rm --no-deps -T -v "$H_ABS:/hermes" --entrypoint python connectors /app/mcp_config.py \
  || warn "could not write the chat-tools config; chat delegation tools will be unavailable"
