#!/usr/bin/env bash
# Notify-only update check. Compares the installed VERSION to the repo's latest
# published VERSION and writes a small status file the dashboard reads. Never
# changes anything on the box — the customer decides when to run update.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_RAW="${UPDATE_VERSION_URL:-https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/VERSION}"
NOTES_URL="${UPDATE_NOTES_URL:-https://github.com/ajr1303/sct-agent-os/releases}"
OUT="data/hermes/brand/update-status.json"
mkdir -p "$(dirname "$OUT")"

cur=$(tr -d '[:space:]' < VERSION 2>/dev/null || true); [ -n "$cur" ] || cur="0.0.0"
latest=$(curl -fsS --max-time 15 "$REPO_RAW" 2>/dev/null | tr -d '[:space:]' || true)

# If we couldn't reach home, leave any existing status untouched (don't flap).
[ -n "$latest" ] || exit 0

avail=false
if [ "$cur" != "$latest" ] && [ "$(printf '%s\n%s\n' "$cur" "$latest" | sort -V | tail -1)" = "$latest" ]; then
  avail=true
fi

tmp="$OUT.tmp"
cat > "$tmp" <<JSON
{"current":"$cur","latest":"$latest","update_available":$avail,"checked_at":"$(date -u +%FT%TZ)","notes_url":"$NOTES_URL"}
JSON
mv "$tmp" "$OUT"
chmod 644 "$OUT" 2>/dev/null || true
