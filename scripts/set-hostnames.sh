#!/usr/bin/env bash
# Point this box at its public (tunnel) hostnames in one step.
#
#   sudo ./scripts/set-hostnames.sh acme-agentos.example.com
#
# From the dashboard hostname it derives the two sibling names used by the
# runbook (same level, so the free Cloudflare certificate covers them):
#   acme-agentos.example.com            -> http://proxy:9119
#   acme-agentos-paperclip.example.com  -> http://paperclip:3100
#   acme-agentos-n8n.example.com        -> http://n8n:5678
# then writes the matching settings to .env (replacing any existing ones) and
# runs update.sh. Create the three routes in Cloudflare with the same names.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

host="${1:-}"
if ! printf '%s' "$host" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  echo "Usage: sudo $0 <dashboard-hostname>   e.g. acme-agentos.example.com" >&2
  exit 1
fi
[ -f .env ] || { echo "No .env here; run the installer first." >&2; exit 1; }

label="${host%%.*}"; zone="${host#*.}"
pc="${label}-paperclip.${zone}"
n8="${label}-n8n.${zone}"

cp -p .env ".env.bak.$(date +%Y%m%d%H%M%S)"
setkv() {  # setkv KEY VALUE : replace every existing KEY= line with one new one
  local tmp; tmp=$(mktemp)
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env; rm -f "$tmp"
}
setkv DASHBOARD_PUBLIC_HOST "$host"
setkv PAPERCLIP_PUBLIC_URL "https://${pc}"
setkv PAPERCLIP_ALLOWED_HOSTNAMES "paperclip,localhost,127.0.0.1,${pc}"
setkv N8N_PUBLIC_URL "https://${n8}/"
setkv N8N_PROTOCOL https
setkv N8N_HOST "$n8"
setkv N8N_SECURE_COOKIE true
setkv N8N_PROXY_HOPS 1

cat <<DONE
Hostnames set. Cloudflare routes for this box's tunnel:
  ${host}  ->  http://proxy:9119
  ${pc}  ->  http://paperclip:3100
  ${n8}  ->  http://n8n:5678
Applying...
DONE
exec ./scripts/update.sh
