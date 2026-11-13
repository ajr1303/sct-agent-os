#!/usr/bin/env bash
# Connect the dashboard to Paperclip in one step.
#   sudo ./scripts/paperclip-connect.sh [owner-email]
# Prerequisite: you have opened Paperclip once and created the owner account.
# This issues a Paperclip board key for that account and hands it straight to the
# dashboard's encrypted key store. The key is never shown on screen, written to a
# file, or put in shell history. Run it again any time to replace the key.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

IN=/tmp/pckey.$$.mjs
cleanup() { docker compose exec -T paperclip rm -f "$IN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker compose cp scripts/lib/paperclip-board-key.mjs "paperclip:$IN" >/dev/null

email="${1:-}"
set +e
docker compose exec -T paperclip node "$IN" "$email" </dev/null \
  | docker compose exec -T connectors python -c '
import sys
tok = sys.stdin.read().strip()
if not tok.startswith("pcp_board_"):
    sys.exit(3)
import app
try:
    app.orchestration_connect(app.PcConnect(api_key=tok), _auth=None)
except Exception as e:
    print("Dashboard could not use the new key: " + str(getattr(e, "detail", e)), file=sys.stderr)
    sys.exit(1)
print("Dashboard connected to Paperclip.")
'
rc=("${PIPESTATUS[@]}")
set -e
if [ "${rc[0]}" = 4 ]; then
  echo "More than one Paperclip account exists. Run again with the owner email:" >&2
  echo "  sudo $0 owner@example.com" >&2
  exit 1
fi
if [ "${rc[0]}" != 0 ] || [ "${rc[1]}" != 0 ]; then
  echo "Not connected. See the message above." >&2
  exit 1
fi
echo "Open the dashboard > Orchestration and refresh."
