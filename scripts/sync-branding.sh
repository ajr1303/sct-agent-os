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
  grep -q '^CHAT_TOOLS_TOKEN=' .env || { echo "CHAT_TOOLS_TOKEN=$(openssl rand -hex 32)" >> .env; echo "Added CHAT_TOOLS_TOKEN to .env"; }
  grep -q '^N8N_ENCRYPTION_KEY=' .env || { echo "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env; echo "Added N8N_ENCRYPTION_KEY to .env"; }
  # Paperclip secrets so the control-plane profile never errors when enabled.
  # (The profile itself stays opt-in — enabling it triggers a heavy source build.)
  grep -q '^BETTER_AUTH_SECRET=' .env || { echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" >> .env; echo "Added BETTER_AUTH_SECRET to .env"; }
  grep -q '^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=' .env || { echo "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)" >> .env; echo "Added PAPERCLIP_TOOL_ACTION_SIGNING_SECRET to .env"; }
  # Paperclip UI address (needed for the one-time board-key setup over the LAN).
  if ! grep -q '^PAPERCLIP_PUBLIC_URL=' .env; then
    _ip=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$_ip" ] || _ip="127.0.0.1"
    echo "PAPERCLIP_PUBLIC_URL=http://${_ip}:3100" >> .env
    grep -q '^PAPERCLIP_ALLOWED_HOSTNAMES=' .env || echo "PAPERCLIP_ALLOWED_HOSTNAMES=paperclip,localhost,127.0.0.1,${_ip}" >> .env
    echo "Added PAPERCLIP_PUBLIC_URL/ALLOWED_HOSTNAMES to .env (detected ${_ip} — edit if wrong)"
  fi
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

# Generate links.js so the dashboard's "Open Paperclip/builder" buttons use the
# configured browser-facing URLs (tunnel hostnames, LAN IP, etc.) instead of
# guessing host:3100 / host:5678. Empty values make the buttons fall back to the
# old host-based guess. Values come from .env; JSON-escape the quote/backslash.
pc_url=""; n8n_url=""
if [ -f .env ]; then
  pc_url=$(sed -n 's/^PAPERCLIP_PUBLIC_URL=//p' .env | tail -n1)
  n8n_url=$(sed -n 's/^N8N_PUBLIC_URL=//p' .env | tail -n1)
  op_name=$(sed -n 's/^OPERATOR_NAME=//p' .env | tail -n1)
  op_support=$(sed -n 's/^SUPPORT_CONTACT=//p' .env | tail -n1)
fi
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
aos_ver=$(tr -cd '0-9.' < VERSION 2>/dev/null)
cat > "$H/brand/links.js" <<JS
window.__SCT_LINKS__ = { "paperclip": "$(esc "$pc_url")", "n8n": "$(esc "$n8n_url")" };
window.__SCT_BRAND__ = { "version": "$(esc "$aos_ver")", "operator": "$(esc "${op_name:-}")", "support": "$(esc "${op_support:-}")" };
JS

chmod 755 "$H/brand"; chmod 644 "$H/brand/"*
for plug in suburban-cyber suburban-chat suburban-mail suburban-bookings suburban-automations suburban-orchestration suburban-tasks; do
  rm -rf "$H/plugins/$plug"
  mkdir -p "$H/plugins/$plug"
  cp -r "plugins/$plug/." "$H/plugins/$plug/"
done
chmod 755 data "$H" "$H/dashboard-themes" "$H/plugins"
find "$H/plugins" -type d -exec chmod 755 {} +
find "$H/plugins" -type f -exec chmod 644 {} +
chmod 644 "$H"/dashboard-themes/*.yaml
