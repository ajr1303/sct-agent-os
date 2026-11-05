#!/usr/bin/env bash
# Update Agent OS in place: pull latest, refresh branding/plugins, restart Hermes.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
./scripts/sync-branding.sh
docker compose up -d
for plug in suburban-cyber suburban-chat; do
  docker compose exec -T hermes hermes plugins enable "$plug" || true
done
docker compose restart hermes
docker compose restart proxy
echo "Updated. Hard-refresh the dashboard (Ctrl+Shift+R)."
