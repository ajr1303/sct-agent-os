#!/usr/bin/env bash
# Import exported n8n workflows into this box's n8n, all switched OFF.
#
#   sudo ./scripts/n8n-import.sh /path/to/folder-of-workflow-json
#
# Prerequisite: the n8n owner account exists (open n8n once and create it).
# What it does: cleans a COPY of the files (scripts/lib/n8n-prepare-import.py),
# copies them into the n8n container, runs n8n's own importer, then removes the
# temporary copies. Your source folder is not changed. Credentials are not part
# of a workflow export: add them in n8n afterwards, then switch workflows on one
# at a time. A workflow with the same id as an existing one is replaced.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

src="${1:-}"
[ -n "$src" ] && [ -d "$src" ] || { echo "Usage: sudo $0 <folder containing workflow .json files>" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required on this machine." >&2; exit 1; }
docker compose ps --status running --services 2>/dev/null | grep -qx n8n \
  || { echo "n8n is not running on this box." >&2; exit 1; }

work=$(mktemp -d)
IN="/tmp/wf-import.$$"
cleanup() {
  rm -rf "$work"
  docker compose exec -T --user root n8n rm -rf "$IN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

python3 scripts/lib/n8n-prepare-import.py "$src" "$work/wf"
docker compose cp "$work/wf" "n8n:$IN" >/dev/null
docker compose exec -T --user root n8n chmod -R a+rX "$IN"

echo "Importing into n8n..."
docker compose exec -T n8n n8n import:workflow --separate --input="$IN" 2>&1 | tail -n 15

total=$(docker compose exec -T n8n n8n list:workflow 2>/dev/null | grep -c '|' || true)
on=$(docker compose exec -T n8n n8n list:workflow --active=true 2>/dev/null | grep -c '|' || true)
echo "n8n now has ${total} workflow(s); ${on} switched on."
echo "Next: add credentials in n8n, then switch workflows on one at a time."
