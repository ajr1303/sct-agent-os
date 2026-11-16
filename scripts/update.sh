#!/usr/bin/env bash
# Update Agent OS in place: pull latest, backfill new secrets, refresh branding/plugins,
# rebuild local services, restart.
set -euo pipefail
cd "$(dirname "$0")/.."

# Phase 1: pull the new code, then hand off to the freshly-pulled copy of this
# script. bash reads a script by byte offset as it runs, so `git pull` rewriting
# update.sh mid-execution can make it run garbled lines. We do ONLY the pull here,
# then re-exec the updated script with a guard env var so the rest runs from the
# new file. The guard prevents an infinite loop.
if [ -z "${AOS_UPDATE_REEXEC:-}" ]; then
  export AOS_PREV_COMMIT; AOS_PREV_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  # A copy of everything before anything changes (kept on this server; it is sent
  # to your cloud storage a few minutes later if that is set up). Never blocks the update.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx agent-os-connectors; then
    echo "Backing up before the update"
    ./scripts/backup.sh --before-update || echo "  ! pre-update backup did not complete; continuing"
  fi
  # Normally a fast-forward. If the published history was rewritten, follow it:
  # .env and data/ are not tracked by git, so nothing of yours is touched.
  if ! git pull --ff-only; then
    br=$(git rev-parse --abbrev-ref HEAD)
    git fetch origin "$br" && git reset --hard "origin/$br"
  fi
  AOS_UPDATE_REEXEC=1 exec bash "$0" "$@"
fi

# Tell the watchdog to stand down while services are rebuilt and restarted, and say
# plainly what state things are in if a step fails.
mkdir -p data && touch data/.maintenance
trap 'rm -f data/.maintenance' EXIT
trap 'echo; echo "x  The update stopped partway. The services that were running are still running."; echo "   Fix the error above and run this again. Version before this update: ${AOS_PREV_COMMIT:-unknown}"' ERR

# Phase 2 (running from the freshly-pulled script).
# Backfill secrets introduced after the original install, so compose won't error
# on a now-required variable that the existing .env predates.
if [ -f .env ] && ! grep -q '^CONNECTORS_KEY=' .env; then
  echo "CONNECTORS_KEY=$(openssl rand -base64 32 | tr '+/' '-_')" >> .env
  echo "Added CONNECTORS_KEY to .env"
fi

# Generate the gateway TLS certs FIRST, before any `docker compose` command runs.
# Docker auto-creates missing bind-mount sources as directories, so the cert files
# must exist before the stack is (re)created or nginx gets handed directories.
# Older installs predate openssl as a prerequisite, so ensure it's present.
if ! command -v openssl >/dev/null 2>&1; then
  echo "Installing openssl (needed for the gateway TLS certs)"
  if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y -qq openssl
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y -q openssl
  elif command -v yum >/dev/null 2>&1; then sudo yum install -y -q openssl
  else echo "  ! openssl not found and no known package manager; install it, then re-run update."; fi
fi
./scripts/gen-tls.sh || echo "  ! gateway TLS generation failed - agents won't run until this is fixed"

mkdir -p data/proxy
mkdir -p data/agent-ssh && chmod 700 data/agent-ssh   # mounted into connectors (see scripts/agent-ssh.sh)
# Automations kept the old default timezone until now; pin it so schedules do not move.
if [ -f .env ] && ! grep -q '^N8N_TIMEZONE=' .env; then
  echo "N8N_TIMEZONE=America/New_York" >> .env
  echo "Kept the automations timezone (America/New_York). Change N8N_TIMEZONE in .env if that is not yours."
fi
# Prefer prebuilt images for this release; fall back to a local build if unavailable.
docker compose pull -q --ignore-pull-failures 2>/dev/null || true
docker compose build connectors
# New dashboard pages go live only once the service behind them has built.
./scripts/sync-branding.sh
# Chat tools: write the MCP entry + routing skill before Hermes restarts below.
./scripts/sync-chat-tools.sh || echo "  ! chat tools setup reported problems"
docker compose up -d
docker compose restart hermes
docker compose restart proxy
# The proxy and gateway-tls configs are bind-mounted, so `up -d` won't reload them
# on a content-only change — only a restart does. gateway-tls is behind the
# control-plane profile; ignore "no such service" when that profile isn't active.
docker compose restart gateway-tls 2>/dev/null || true
# Re-enable plugins on every profile AFTER the restart, so the enable lands on a
# ready gateway (enable-plugins.sh waits for readiness and covers all profiles).
./scripts/enable-plugins.sh || echo "  ! plugin enable reported problems; check: docker compose logs hermes"
# Every scheduled job (watchdog, backups, update check, dashboard requests), so an
# install that predates one of them, or never finished, still ends up with all of them.
mkdir -p backups data/backup && chmod 700 backups data/backup
./scripts/install-cron.sh || true
./scripts/host-requests.sh || true   # keeps the two-step sign-in switch in step after the proxy was recreated
./scripts/agent-models.sh || echo "  ! could not read agent models; the Agents page will show them as not checked"
./scripts/check-updates.sh 2>/dev/null || true   # refresh update status (clears the banner)
rm -f data/.install-incomplete
echo "Updated to $(cat VERSION 2>/dev/null). Hard-refresh the dashboard (Ctrl+Shift+R)."
echo "Dashboard login: admin. Forgotten password with no reset code: sudo ./scripts/dashboard-password.sh"
