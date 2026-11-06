#!/usr/bin/env bash
# Copy themes and the dashboard plugins into the Hermes data dir with container-readable permissions.
set -euo pipefail
cd "$(dirname "$0")/.."

# Backfill secrets introduced after the original install, so `docker compose`
# won't error on a now-required variable the existing .env predates. Runs here
# (not just update.sh) because update.sh calls this before `compose up` on the
# first pass, which is still the old update.sh that lacks the backfill.
if [ -f .env ] && ! grep -q '^CONNECTORS_KEY=' .env; then
  echo "CONNECTORS_KEY=$(openssl rand -base64 32 | tr '+/' '-_')" >> .env
  echo "Added CONNECTORS_KEY to .env"
fi

H=data/hermes
mkdir -p "$H/dashboard-themes" "$H/plugins" "$H/brand"
cp templates/dashboard-themes/*.yaml "$H/dashboard-themes/"
cp brand/* "$H/brand/"
chmod 755 "$H/brand"; chmod 644 "$H/brand/"*
for plug in suburban-cyber suburban-chat suburban-mail suburban-bookings; do
  rm -rf "$H/plugins/$plug"
  mkdir -p "$H/plugins/$plug"
  cp -r "plugins/$plug/." "$H/plugins/$plug/"
done
chmod 755 data "$H" "$H/dashboard-themes" "$H/plugins"
find "$H/plugins" -type d -exec chmod 755 {} +
find "$H/plugins" -type f -exec chmod 644 {} +
chmod 644 "$H"/dashboard-themes/*.yaml
