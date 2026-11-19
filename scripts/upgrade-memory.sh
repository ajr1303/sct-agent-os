#!/usr/bin/env bash
# Safe upgrade of the memory service (Honcho) when a release moves to a new version.
#
# A new Honcho version changes the memory database when it first starts, and the old
# version cannot read the changed database. So the updater calls this script twice:
#
#   upgrade-memory.sh prepare   before the new containers start: stop Honcho, save a
#                               copy of the memory database, note what is being upgraded
#   upgrade-memory.sh verify    after they start: wait for the new version to come up
#                               healthy; if it does not, put the saved copy back and
#                               return to the version that was running
#
#   upgrade-memory.sh retry     try an upgrade again after it was rolled back
#   upgrade-memory.sh status    say which version runs and whether a rollback is in place
#
# Nothing here runs unless the memory service is installed and its version is changing.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

STATE=data/backup/memory-upgrade.state        # an upgrade in progress
FAILED=data/backup/memory-upgrade.failed      # the version that was rolled back
API=agent-os-honcho-api
DB=agent-os-honcho-db
WAIT=${MEMORY_UPGRADE_WAIT:-900}              # seconds to wait for the new version

say()  { echo "memory: $*"; }
running() { docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"; }
# The version this release ships, whatever .env currently overrides.
shipped() { sed -n 's/.*\${HONCHO_IMAGE:-\([^}]*\)}.*/\1/p' docker-compose.yml | head -n1; }
current() { docker inspect -f '{{.Config.Image}}' "$API" 2>/dev/null || true; }
pinned()  { sed -n 's/^HONCHO_IMAGE=//p' .env 2>/dev/null | tail -n1; }
unpin()   { [ -f .env ] && sed -i '/^HONCHO_IMAGE=/d; /^# Memory upgrade rolled back/d' .env; }

db_ready() {
  for _ in $(seq 1 30); do docker exec "$DB" pg_isready -U honcho >/dev/null 2>&1 && return 0; sleep 2; done
  return 1
}

prepare() {
  rm -f "$STATE"
  running "$DB" || return 0                     # memory is not installed, or not running
  local cur new failed
  cur=$(current); new=$(shipped)
  [ -n "$cur" ] && [ -n "$new" ] || return 0
  failed=$(cat "$FAILED" 2>/dev/null || true)
  if [ -n "$failed" ]; then
    if [ "$failed" = "$new" ]; then
      say "the upgrade to ${new##*:} was rolled back earlier, so memory stays on ${cur##*:}."
      say "to try again: sudo ./scripts/upgrade-memory.sh retry"
      return 0
    fi
    unpin; rm -f "$FAILED"                      # a different version now: try that one
  fi
  [ "$cur" = "$new" ] && return 0
  [ -n "$(pinned)" ] && return 0                # an operator chose an image in .env; leave it

  say "upgrading the memory service (${cur##*:} to ${new##*:}). Saving a copy of memory first."
  mkdir -p backups data/backup && chmod 700 backups data/backup
  docker compose stop honcho-deriver honcho-api >/dev/null 2>&1 || true
  local dump
  dump="backups/honcho-before-upgrade-$(date +%Y%m%d-%H%M%S).sql.gz"
  if db_ready && docker exec "$DB" pg_dump -U honcho honcho 2>/dev/null | gzip > "$dump" \
     && gzip -t "$dump" 2>/dev/null && [ "$(gunzip -c "$dump" | head -c 4096 | grep -c 'PostgreSQL database dump')" -ge 1 ]; then
    chmod 600 "$dump"
    printf '%s\n%s\n%s\n' "$cur" "$new" "$dump" > "$STATE"
    say "copy saved: $dump"
  else
    rm -f "$dump"
    say "could not save a copy of memory, so the memory service is NOT being upgraded this time."
    unpin
    printf '# Memory upgrade rolled back or skipped; remove this line and the next to retry.\nHONCHO_IMAGE=%s\n' "$cur" >> .env
    echo "$new" > "$FAILED"
  fi
}

healthy() { [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$API" 2>/dev/null)" = healthy ]; }

rollback() { # rollback OLD_IMAGE NEW_IMAGE DUMP
  local old="$1" new="$2" dump="$3" ok=1
  say "the new version did not start. Putting memory back the way it was."
  docker logs --tail 80 "$API" > backups/memory-upgrade-failed.log 2>&1 || true
  docker compose stop honcho-deriver honcho-api >/dev/null 2>&1 || true
  if [ -f "$dump" ] && db_ready \
     && docker exec "$DB" psql -U honcho -d postgres -q -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS honcho WITH (FORCE)' -c 'CREATE DATABASE honcho' >/dev/null 2>&1 \
     && gunzip -c "$dump" | docker exec -i "$DB" psql -U honcho -d honcho -q -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
    ok=0
  fi
  unpin
  printf '# Memory upgrade rolled back or skipped; remove this line and the next to retry.\nHONCHO_IMAGE=%s\n' "$old" >> .env
  echo "$new" > "$FAILED"
  docker compose up -d honcho-api honcho-deriver >/dev/null 2>&1 || true
  if [ "$ok" = 0 ]; then
    say "memory is back on ${old##*:} with everything it held before the update."
  else
    say "!! the saved copy could not be put back automatically. It is safe at: $dump"
    say "!! restore it by hand (docs/RUNBOOK.md, memory upgrade) before using memory."
  fi
  say "what went wrong is in backups/memory-upgrade-failed.log. To try again later: sudo ./scripts/upgrade-memory.sh retry"
}

verify() {
  [ -f "$STATE" ] || return 0
  local old new dump t=0 restarts
  { read -r old; read -r new; read -r dump; } < "$STATE"
  say "waiting for the new version to finish updating the memory database"
  while [ "$t" -lt "$WAIT" ]; do
    if healthy; then
      rm -f "$STATE" "$FAILED"
      say "memory service is on ${new##*:}. The copy from before is kept for 14 days: $dump"
      return 0
    fi
    restarts=$(docker inspect -f '{{.RestartCount}}' "$API" 2>/dev/null || echo 0)
    [ "${restarts:-0}" -ge 4 ] && break         # it keeps crashing; no point waiting longer
    sleep 5; t=$((t + 5))
  done
  rollback "$old" "$new" "$dump"
  rm -f "$STATE"
  return 0
}

case "${1:-}" in
  prepare) prepare ;;
  verify)  verify ;;
  retry)
    unpin; rm -f "$FAILED"
    say "cleared. Running the upgrade now."
    prepare
    docker compose pull -q honcho-api 2>/dev/null || true
    docker compose up -d honcho-api honcho-deriver
    verify ;;
  status)
    say "running: $(current || echo 'not running')   this release ships: $(shipped)"
    [ -f "$FAILED" ] && say "an upgrade to $(cat "$FAILED") was rolled back. To try again: sudo ./scripts/upgrade-memory.sh retry"
    exit 0 ;;
  *) echo "usage: $0 prepare|verify|retry|status" >&2; exit 2 ;;
esac
