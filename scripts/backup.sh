#!/usr/bin/env bash
# Full Agent OS backup: every database, the agents' files and the settings needed to
# rebuild this server, packed into one archive in backups/.
#
#   scripts/backup.sh                 run a backup now (cron runs this nightly)
#   scripts/backup.sh --if-requested  run only if "Back up now" was pressed in the dashboard
#   scripts/backup.sh --retry-upload  send the newest backup to cloud storage again, now
#
# The archive is encrypted and copied to cloud storage once those are set up on the
# dashboard's Backups page (or in the installer). Until then it stays on this server,
# unencrypted, which protects against a bad update but not against losing the machine.
# Restore with scripts/restore.sh.
set -u
cd "$(dirname "$0")/.." || exit 1

if [ "${1:-}" = "--if-requested" ]; then
  if [ ! -f data/backup/run-now ]; then
    # Nothing asked for. If the last backup could not be uploaded, try that again
    # (the tool spaces its own attempts, so this is cheap to call every 5 minutes).
    docker ps --format '{{.Names}}' | grep -qx agent-os-connectors \
      && docker exec agent-os-connectors python /app/backup_tool.py retry-upload
    exit 0
  fi
  rm -f data/backup/run-now
elif [ "${1:-}" = "--retry-upload" ]; then
  exec docker exec agent-os-connectors python /app/backup_tool.py retry-upload --now
fi

mkdir -p backups data/backup
chmod 700 backups data/backup 2>/dev/null || true
exec 9>backups/.lock
if command -v flock >/dev/null 2>&1; then flock -n 9 || { echo "backup: another backup is still running"; exit 0; }; fi

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }
if ! running agent-os-connectors; then
  echo "backup: the connectors service is not running, so nothing was backed up" >&2
  exit 1
fi

STAGE=backups/.stage
rm -rf "$STAGE"; mkdir -p "$STAGE"; chmod 700 "$STAGE"
FAILED=""
fail() { FAILED="${FAILED:+$FAILED,}$1"; rm -f "$STAGE/$1"; echo "backup: could not save $1" >&2; }
PF=pipefail; set -o $PF

# 1. Agent memory (Honcho, Postgres)
if running agent-os-honcho-db; then
  docker exec agent-os-honcho-db pg_dump -U honcho honcho 2>/dev/null | gzip > "$STAGE/honcho.sql.gz" || fail honcho.sql.gz
fi

# 2. The team: Paperclip's database, then its files (keys, uploads, agent instructions)
if running agent-os-paperclip; then
  docker exec agent-os-paperclip sh -c '
    rm -rf /tmp/aosbk && mkdir -p /tmp/aosbk && cd /app &&
    node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts db:backup \
      --dir /tmp/aosbk --filename-prefix agentos >/dev/null 2>&1
    f=$(ls -t /tmp/aosbk/agentos-* 2>/dev/null | head -1)
    # No fresh dump: fall back to the newest hourly one Paperclip makes itself.
    [ -n "$f" ] || f=$(ls -t /paperclip/instances/default/data/backups/*.sql* 2>/dev/null | head -1)
    [ -n "$f" ] || exit 1
    case "$f" in *.gz) cat "$f" ;; *) gzip -c "$f" ;; esac
    rc=$?; rm -rf /tmp/aosbk; exit $rc' > "$STAGE/paperclip-db.sql.gz" || fail paperclip-db.sql.gz
  docker exec agent-os-paperclip tar -C /paperclip/instances/default -czf - \
    --exclude=./db --exclude=./data/backups --exclude=./logs --exclude=./workspaces \
    --exclude=./projects --exclude='*/node_modules' --exclude='*/.git' . \
    > "$STAGE/paperclip-files.tar.gz" 2>/dev/null || fail paperclip-files.tar.gz
fi

# 3. Automations (n8n): workflows and credentials. Credentials stay encrypted with
#    N8N_ENCRYPTION_KEY, which is in .env (part 6).
if running agent-os-n8n; then
  docker exec agent-os-n8n sh -c '
    rm -rf /tmp/aosbk && mkdir -p /tmp/aosbk/workflows /tmp/aosbk/credentials &&
    n8n export:workflow --backup --output=/tmp/aosbk/workflows >/dev/null 2>&1
    n8n export:credentials --backup --output=/tmp/aosbk/credentials >/dev/null 2>&1
    tar -C /tmp/aosbk -czf - . ; rc=$?; rm -rf /tmp/aosbk; exit $rc' \
    > "$STAGE/n8n.tar.gz" || fail n8n.tar.gz
fi

# 4. Dashboard connections (mailboxes, bookings, usage, agent settings)
docker exec agent-os-connectors python -c "
import sqlite3
s = sqlite3.connect('/data/connectors.db'); d = sqlite3.connect('/backups/.stage/connectors.db')
s.backup(d); d.close(); s.close()" || fail connectors.db

# 5. Hermes: profiles, skills, sessions, plugins (not logs or caches)
HH=$(grep -E '^HERMES_HOME_DIR=' .env 2>/dev/null | tail -1 | cut -d= -f2-); HH=${HH:-./data/hermes}
if [ -d "$HH" ]; then
  tar -C "$HH" -czf "$STAGE/hermes-home.tar.gz" --warning=no-file-changed \
    --exclude=./logs --exclude='*/logs' --exclude='*.log' --exclude=./cache --exclude='*/cache' \
    --exclude='*/node_modules' --exclude='*/__pycache__' . 2>/dev/null
  [ $? -le 1 ] || fail hermes-home.tar.gz
fi

# 6. Settings: secrets file, certificates, agent SSH access, backup settings.
#    The recovery kit is never included: it must not sit next to what it opens.
CFG=""
for f in .env honcho.env data/tls data/agent-ssh data/backup/settings.json data/backup/rclone.conf VERSION; do
  [ -e "$f" ] && CFG="$CFG $f"
done
# shellcheck disable=SC2086
tar -czf "$STAGE/config.tar.gz" $CFG 2>/dev/null || fail config.tar.gz

set +o $PF
docker exec agent-os-connectors python /app/backup_tool.py finish /backups/.stage "$(cat VERSION 2>/dev/null)" "$FAILED"
RC=$?
rm -rf "$STAGE"
exit $RC
