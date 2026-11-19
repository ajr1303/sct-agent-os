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
trap 'resume_team; rm -f data/.maintenance' EXIT
trap 'echo; echo "x  The update stopped partway. The services that were running are still running."; echo "   Fix the error above and run this again. Version before this update: ${AOS_PREV_COMMIT:-unknown}"' ERR

# Safe updates: ask the connectors service (inside its container, with the internal
# token) about the team. Every call is best effort: an install too old to answer, or a
# team board that is not set up, simply means the update goes ahead as it always did.
aos_team() {
  docker compose exec -T connectors python -c 'import os,sys,urllib.request
r=urllib.request.Request("http://127.0.0.1:8000/internal/update/"+sys.argv[1],data=b"{}",headers={"Authorization":"Bearer "+os.environ.get("CHAT_TOOLS_TOKEN",""),"Content-Type":"application/json"})
print(urllib.request.urlopen(r,timeout=30).read().decode())' "$1" 2>/dev/null || true
}
aos_field() { python3 -c 'import sys,json
try: d=json.loads(sys.argv[1] or "{}")
except Exception: d={}
v=d.get(sys.argv[2]); print(", ".join(v) if isinstance(v,list) else ("" if v is None else str(v).lower() if isinstance(v,bool) else v))' "$1" "$2" 2>/dev/null || true; }
AOS_TEAM_PAUSED=""
# Wait for a quiet moment, then stop new work from starting. Pausing the team stops
# running work, so it is only done once nothing is running. AOS_UPDATE_WAIT is the
# longest to wait, in seconds (0 = do not wait).
quiet_then_pause() {
  local limit=${AOS_UPDATE_WAIT:-300} waited=0 r n
  r=$(aos_team pause); [ -n "$r" ] || return 0
  [ "$(aos_field "$r" skip)" = true ] && return 0
  while :; do
    if [ "$(aos_field "$r" paused)" = true ]; then
      AOS_TEAM_PAUSED=1; echo "Nothing is running. Paused the team so no task starts during the restart."; return 0
    fi
    [ "$(aos_field "$r" already)" = true ] && { echo "The team is already paused; leaving it that way."; return 0; }
    n=$(aos_field "$r" running); [ -n "$n" ] || return 0
    if [ "$waited" -ge "$limit" ]; then
      echo "  ! Still running after $((limit / 60)) min: $(aos_field "$r" who). Going ahead; a task cut off by the restart is retried automatically."
      return 0
    fi
    [ "$waited" -eq 0 ] && echo "Waiting for running tasks to finish before restarting (up to $((limit / 60)) min): $(aos_field "$r" who)"
    sleep 15; waited=$((waited + 15)); r=$(aos_team pause); [ -n "$r" ] || return 0
  done
}
# Switch the team back on. Runs at the end, and from the failure handler too.
resume_team() {
  [ -n "$AOS_TEAM_PAUSED" ] || return 0
  local r
  for _ in $(seq 1 24); do
    r=$(aos_team resume)
    if [ -n "$r" ] && [ "$(aos_field "$r" ok)" = true ]; then AOS_TEAM_PAUSED=""; echo "Switched the team back on."; return 0; fi
    sleep 5
  done
  echo "  ! Could not switch the team back on. It switches itself on within 45 minutes, or resume it from the dashboard."
}

# Phase 2 (running from the freshly-pulled script).
# Backfill secrets introduced after the original install, so compose won't error
# on a now-required variable that the existing .env predates.
# A linked team already has its owner account: close new sign-ups in Paperclip.
if [ -f .env ] && ! grep -q '^PAPERCLIP_DISABLE_SIGNUP=' .env; then
  linked=$(docker compose exec -T connectors python -c 'import sqlite3,os
print(sqlite3.connect(os.environ.get("CONNECTORS_DB","/data/connectors.db")).execute("SELECT count(*) FROM orchestration").fetchone()[0])' 2>/dev/null | tr -cd '0-9' || true)
  if [ "${linked:-0}" -gt 0 ] 2>/dev/null || grep -Eq '^PAPERCLIP_API_KEY=.+' .env; then
    echo "PAPERCLIP_DISABLE_SIGNUP=true" >> .env
    echo "Closed new account sign-up in Paperclip (the team is already linked)"
  fi
fi
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
# Memory: an install made before the installer gave the owner a default name can have
# an empty name in honcho.json. Hermes then switches memory off in every chat and says
# so at the end of each answer. Fill the gap; never change a name that is already set.
HJ=data/hermes/honcho.json
if [ -f "$HJ" ]; then
  fixed=$(sed -E -e 's/("peerName":[[:space:]]*)""/\1"owner"/' -e 's/("aiPeer":[[:space:]]*)""/\1"assistant"/' "$HJ")
  if ! printf '%s' "$fixed" | grep -q '"peerName"'; then
    # No owner entry at all: add one after the agent's, when that line ends in a comma.
    fixed=$(printf '%s\n' "$fixed" | sed -E '/"aiPeer":[[:space:]]*"[^"]*",[[:space:]]*$/a\      "peerName": "owner",')
  fi
  if [ -n "$fixed" ] && [ "$fixed" != "$(cat "$HJ")" ]; then
    cp -p "$HJ" "$HJ.bak" && printf '%s\n' "$fixed" > "$HJ"
    echo "Memory had no owner name set, which switched it off in chat. Set it to \"owner\" (previous file kept as honcho.json.bak)."
  fi
fi
# The memory settings are written by root, but Hermes runs as its own user inside the
# container. If it cannot read the file it turns memory off in every chat. Give the
# file the same owner as Hermes' own config.
fix_memory_owner() {
  local f=data/hermes/honcho.json ref=data/hermes/config.yaml
  [ -f "$f" ] || return 0
  [ -f "$ref" ] || ref=data/hermes
  if [ "$(stat -c '%u:%g' "$f")" != "$(stat -c '%u:%g' "$ref")" ]; then
    chown --reference="$ref" "$f" && echo "Memory settings were not readable by the agent service, which switched memory off in chat. Fixed."
  fi
  chmod 600 "$f"
}
fix_memory_owner
# Pictures the assistant makes with its own image tool land in this folder. The
# dashboard reads them from there to show them in Chat, so the folder has to exist
# before the containers start, owned by whoever owns the rest of the agent's files.
ensure_image_dir() {
  local base=data/hermes ref=data/hermes/config.yaml d
  [ -d "$base" ] || return 0
  [ -f "$ref" ] || ref=$base
  for d in "$base/cache" "$base/cache/generated" "$base/cache/generated/images"; do
    if [ ! -d "$d" ]; then mkdir -p "$d" && chown --reference="$ref" "$d" 2>/dev/null || true; fi
  done
}
ensure_image_dir
# Prefer prebuilt images for this release; fall back to a local build if unavailable.
docker compose pull -q --ignore-pull-failures 2>/dev/null || true
docker compose build connectors
# New dashboard pages go live only once the service behind them has built.
./scripts/sync-branding.sh
# Chat tools: write the MCP entry + routing skill before Hermes restarts below.
./scripts/sync-chat-tools.sh || echo "  ! chat tools setup reported problems"
quiet_then_pause
# A release that moves the memory service to a new version changes the memory
# database on first start. Save a copy first, and go back to it if the new version
# does not come up (scripts/upgrade-memory.sh).
./scripts/upgrade-memory.sh prepare || echo "  ! memory upgrade check reported problems"
if [ -f data/backup/memory-upgrade.state ]; then
  docker compose up -d || true    # a memory service that fails to start is dealt with on the next line
  ./scripts/upgrade-memory.sh verify || echo "  ! memory upgrade check reported problems"
fi
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
resume_team
# Every scheduled job (watchdog, backups, update check, dashboard requests), so an
# install that predates one of them, or never finished, still ends up with all of them.
mkdir -p backups data/backup && chmod 700 backups data/backup
./scripts/install-cron.sh || true
./scripts/host-requests.sh || true   # keeps the two-step sign-in switch in step after the proxy was recreated
./scripts/agent-models.sh || echo "  ! could not read agent models; the Agents page will show them as not checked"
./scripts/check-updates.sh 2>/dev/null || true   # refresh update status (clears the banner)
rm -f data/.install-incomplete
echo "Updated to $(cat VERSION 2>/dev/null). Hard-refresh the dashboard (Ctrl+Shift+R)."
echo "Forgotten dashboard password with no reset code: sudo ./scripts/dashboard-password.sh"
