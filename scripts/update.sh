#!/usr/bin/env bash
# Update Agent OS in place: pull latest, backfill new secrets, refresh branding/plugins,
# rebuild local services, restart.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only

# Backfill secrets introduced after the original install, so compose won't error
# on a now-required variable that the existing .env predates.
if [ -f .env ] && ! grep -q '^CONNECTORS_KEY=' .env; then
  echo "CONNECTORS_KEY=$(openssl rand -base64 32 | tr '+/' '-_')" >> .env
  echo "Added CONNECTORS_KEY to .env"
fi

./scripts/sync-branding.sh
docker compose build connectors
docker compose up -d
for plug in suburban-cyber suburban-chat suburban-mail suburban-bookings; do
  docker compose exec -T hermes hermes plugins enable "$plug" || true
done
docker compose restart hermes
docker compose restart proxy
echo "Updated. Hard-refresh the dashboard (Ctrl+Shift+R)."
