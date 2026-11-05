#!/usr/bin/env bash
# Copy themes and the dashboard plugin into the Hermes data dir with container-readable permissions.
set -euo pipefail
cd "$(dirname "$0")/.."
H=data/hermes
mkdir -p "$H/dashboard-themes" "$H/plugins/suburban-cyber"
cp templates/dashboard-themes/*.yaml "$H/dashboard-themes/"
rm -rf "$H/plugins/suburban-cyber/dashboard"
cp -r plugins/suburban-cyber/dashboard "$H/plugins/suburban-cyber/dashboard"
chmod 755 data "$H" "$H/dashboard-themes" "$H/plugins" "$H/plugins/suburban-cyber"
find "$H/plugins/suburban-cyber" -type d -exec chmod 755 {} +
find "$H/plugins/suburban-cyber" -type f -exec chmod 644 {} +
chmod 644 "$H"/dashboard-themes/*.yaml
