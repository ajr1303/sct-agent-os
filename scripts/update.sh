#!/usr/bin/env bash
# Update Agent OS in place: pull latest, refresh branding, restart Hermes.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
./scripts/sync-branding.sh
docker compose up -d
docker compose exec -T hermes hermes plugins enable suburban-cyber || true
docker compose restart hermes
echo "Updated. Hard-refresh the dashboard (Ctrl+Shift+R)."
