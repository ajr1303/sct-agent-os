#!/usr/bin/env bash
# (Re)install the Honcho memory plugin into Hermes. Use when the installer printed
# "memory plugin install failed", or `hermes memory status` shows no provider.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

H=$(sed -n 's/^HERMES_HOME_DIR=//p' .env 2>/dev/null | tail -n1); H=${H:-./data/hermes}
own=$(stat -c '%u:%g' "$H/config.yaml" 2>/dev/null || true)
if [ -z "$own" ] || [ "$own" = "0:0" ]; then
  echo "Could not tell which user Hermes runs as ($H/config.yaml missing or root-owned)." >&2
  echo "Run Hermes setup first: docker compose run --rm -it hermes setup" >&2
  exit 1
fi
# The plugins dir is created by root; Hermes runs as its own user and needs to
# create a temp dir in it. Our own plugins inside stay root-owned and readable.
chown "$own" "$H/plugins" || exit 1
docker compose run --rm hermes plugins install honcho || { echo "Plugin install failed." >&2; exit 1; }
# Recreate (not just restart) so Hermes picks up HONCHO_API_KEY from docker-compose.yml.
docker compose up -d hermes
sleep 8
docker compose exec -T hermes hermes memory status 2>/dev/null | sed -n '1,14p' || true
