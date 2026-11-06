#!/usr/bin/env bash
# Copy themes and the dashboard plugins into the Hermes data dir with container-readable permissions.
set -euo pipefail
cd "$(dirname "$0")/.."

# Backfill secrets/profiles introduced after the original install, so `docker
# compose` won't error on a now-required variable the existing .env predates.
# Runs here (not just update.sh) because update.sh calls this before `compose up`
# on the first pass, which is still the old update.sh that lacks the backfill.
if [ -f .env ]; then
  grep -q '^CONNECTORS_KEY=' .env || { echo "CONNECTORS_KEY=$(openssl rand -base64 32 | tr '+/' '-_')" >> .env; echo "Added CONNECTORS_KEY to .env"; }
  grep -q '^N8N_ENCRYPTION_KEY=' .env || { echo "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env; echo "Added N8N_ENCRYPTION_KEY to .env"; }
  # Paperclip secrets so the control-plane profile never errors when enabled.
  # (The profile itself stays opt-in — enabling it triggers a heavy source build.)
  grep -q '^BETTER_AUTH_SECRET=' .env || { echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" >> .env; echo "Added BETTER_AUTH_SECRET to .env"; }
  grep -q '^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=' .env || { echo "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)" >> .env; echo "Added PAPERCLIP_TOOL_ACTION_SIGNING_SECRET to .env"; }
  # Ensure the bundled automation engine (n8n) profile is active.
  if grep -q '^COMPOSE_PROFILES=' .env; then
    cur=$(grep '^COMPOSE_PROFILES=' .env | head -1 | cut -d= -f2-)
    case ",$cur," in
      *,automation,*) : ;;
      *) [ -z "$cur" ] && new="automation" || new="$cur,automation"
         sed -i "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=$new|" .env
         echo "Enabled automation profile in COMPOSE_PROFILES" ;;
    esac
  else
    echo "COMPOSE_PROFILES=automation" >> .env
    echo "Added COMPOSE_PROFILES=automation to .env"
  fi
fi

H=data/hermes
mkdir -p "$H/dashboard-themes" "$H/plugins" "$H/brand"
cp templates/dashboard-themes/*.yaml "$H/dashboard-themes/"
cp brand/* "$H/brand/"
chmod 755 "$H/brand"; chmod 644 "$H/brand/"*
for plug in suburban-cyber suburban-chat suburban-mail suburban-bookings suburban-automations suburban-orchestration; do
  rm -rf "$H/plugins/$plug"
  mkdir -p "$H/plugins/$plug"
  cp -r "plugins/$plug/." "$H/plugins/$plug/"
done
chmod 755 data "$H" "$H/dashboard-themes" "$H/plugins"
find "$H/plugins" -type d -exec chmod 755 {} +
find "$H/plugins" -type f -exec chmod 644 {} +
chmod 644 "$H"/dashboard-themes/*.yaml
