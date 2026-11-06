#!/usr/bin/env bash
# Copy themes and the dashboard plugins into the Hermes data dir with container-readable permissions.
set -euo pipefail
cd "$(dirname "$0")/.."
H=data/hermes
mkdir -p "$H/dashboard-themes" "$H/plugins" "$H/brand"
cp templates/dashboard-themes/*.yaml "$H/dashboard-themes/"
cp brand/* "$H/brand/"
chmod 755 "$H/brand"; chmod 644 "$H/brand/"*
for plug in suburban-cyber suburban-chat suburban-mail; do
  rm -rf "$H/plugins/$plug"
  mkdir -p "$H/plugins/$plug"
  cp -r "plugins/$plug/." "$H/plugins/$plug/"
done
chmod 755 data "$H" "$H/dashboard-themes" "$H/plugins"
find "$H/plugins" -type d -exec chmod 755 {} +
find "$H/plugins" -type f -exec chmod 644 {} +
chmod 644 "$H"/dashboard-themes/*.yaml
