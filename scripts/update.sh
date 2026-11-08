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
  git pull --ff-only
  AOS_UPDATE_REEXEC=1 exec bash "$0" "$@"
fi

# Phase 2 (running from the freshly-pulled script).
# Backfill secrets introduced after the original install, so compose won't error
# on a now-required variable that the existing .env predates.
if [ -f .env ] && ! grep -q '^CONNECTORS_KEY=' .env; then
  echo "CONNECTORS_KEY=$(openssl rand -base64 32 | tr '+/' '-_')" >> .env
  echo "Added CONNECTORS_KEY to .env"
fi

./scripts/sync-branding.sh
# Older installs predate openssl as a prerequisite; the gateway TLS certs need it.
if ! command -v openssl >/dev/null 2>&1; then
  echo "Installing openssl (needed for the gateway TLS certs)"
  if   command -v apt-get >/dev/null 2>&1; then sudo apt-get update -qq && sudo apt-get install -y -qq openssl
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y -q openssl
  elif command -v yum >/dev/null 2>&1; then sudo yum install -y -q openssl
  else echo "  ! openssl not found and no known package manager; install it, then re-run update."; fi
fi
./scripts/gen-tls.sh || echo "  ! gateway TLS generation failed - agents won't run until this is fixed"
docker compose build connectors
docker compose up -d
docker compose restart hermes
docker compose restart proxy
# Re-enable plugins on every profile AFTER the restart, so the enable lands on a
# ready gateway (enable-plugins.sh waits for readiness and covers all profiles).
./scripts/enable-plugins.sh || echo "  ! plugin enable reported problems; check: docker compose logs hermes"
# Ensure the periodic update-check cron exists (for installs that predate it).
if command -v crontab >/dev/null 2>&1 && ! crontab -l 2>/dev/null | grep -q 'check-updates.sh'; then
  { crontab -l 2>/dev/null; echo "17 */6 * * * $(pwd)/scripts/check-updates.sh # agent-os-managed"; } | crontab - && echo "Added update-check to cron"
fi
./scripts/check-updates.sh 2>/dev/null || true   # refresh update status (clears the banner)
echo "Updated to $(cat VERSION 2>/dev/null). Hard-refresh the dashboard (Ctrl+Shift+R)."
