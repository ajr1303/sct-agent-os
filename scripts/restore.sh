#!/usr/bin/env bash
# Open an Agent OS backup and put it back.
#
#   scripts/restore.sh <backup file> [key file]             open and check it; change nothing
#   scripts/restore.sh <backup file> [key file] --apply     restore onto this server
#
# <key file> is the recovery kit (or the operator's key file). It is only needed for
# encrypted backups (names ending in .age). A backup stored in the cloud must be
# downloaded first; any computer can do that, the file is useless without a key.
#
# --apply expects a server where ./install.sh has already run (so the services exist),
# stops the stack, restores each part, and starts it again. Anything it cannot restore
# by itself is left in the unpacked folder with a note saying what to do.
set -u
cd "$(dirname "$0")/.." || exit 1
ARCHIVE=""; KEY=""; APPLY=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    *) if [ -z "$ARCHIVE" ]; then ARCHIVE=$a; else KEY=$a; fi ;;
  esac
done
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

say() { printf '%s\n' "$*"; }
die() { printf 'restore: %s\n' "$*" >&2; exit 1; }

# age lives in the connectors image, so the host needs nothing but Docker.
run_age() {
  if command -v age >/dev/null 2>&1; then age "$@"
  else docker run --rm -i -v "$KEYDIR:/k:ro" --entrypoint age agent-os/connectors:0.1 "$@"; fi
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/agent-os-restore.XXXXXX") || die "could not create a work folder"
chmod 700 "$WORK"
case "$ARCHIVE" in
  *.age)
    [ -n "$KEY" ] && [ -f "$KEY" ] || die "this backup is encrypted: give the recovery kit file as the second argument"
    KEYDIR=$(cd "$(dirname "$KEY")" && pwd); KEYNAME=$(basename "$KEY")
    if command -v age >/dev/null 2>&1; then KEYARG="$KEYDIR/$KEYNAME"; else KEYARG="/k/$KEYNAME"; fi
    run_age -d -i "$KEYARG" < "$ARCHIVE" | tar -xzf - -C "$WORK" || die "could not open the backup with that key"
    ;;
  *) tar -xzf "$ARCHIVE" -C "$WORK" || die "could not unpack the backup" ;;
esac
[ -f "$WORK/manifest.json" ] || die "this does not look like an Agent OS backup (no manifest)"

# Check every part against the fingerprints recorded when the backup was made.
if command -v python3 >/dev/null 2>&1; then PY="python3"
else PY="docker run --rm -i -v $WORK:$WORK:ro --entrypoint python agent-os/connectors:0.1"; fi
$PY - "$WORK" <<'PY' || die "the backup did not pass its integrity check"
import sys, json, hashlib, os
w = sys.argv[1]; man = json.load(open(os.path.join(w, "manifest.json"))); bad = 0
print("Backup made %s by Agent OS %s" % (man.get("created_at"), man.get("agent_os_version") or "?"))
for c in man["components"]:
    p = os.path.join(w, c["file"]); h = hashlib.sha256()
    if not os.path.exists(p):
        print("  MISSING  %s" % c["file"]); bad += 1; continue
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    ok = (not c.get("sha256")) or h.hexdigest() == c["sha256"]
    print("  %s  %-24s %8.1f MB" % ("ok     " if ok else "DAMAGED", c["file"], c["bytes"] / 1e6)); bad += 0 if ok else 1
sys.exit(1 if bad else 0)
PY

if [ "$APPLY" != 1 ]; then
  say ""
  say "The backup opens and every part is intact. Nothing was changed."
  say "Unpacked copy: $WORK   (contains secrets; delete it when done: rm -rf $WORK)"
  say "To restore onto this server: $0 $ARCHIVE ${KEY:+$KEY }--apply"
  exit 0
fi

[ "$(id -u)" = 0 ] || die "--apply needs root (sudo)"
[ -f docker-compose.yml ] || die "run this from an installed Agent OS folder"
say ""
say "This replaces the data on THIS server with the backup's. Type RESTORE to continue:"
read -r ok; [ "$ok" = "RESTORE" ] || die "cancelled; nothing was changed"

NOTES=""
note() { NOTES="$NOTES\n  - $1"; }
vol() { docker volume ls --format '{{.Name}}' | grep -E "(^|_)$1\$" | head -1; }

say "Stopping services"
docker compose --profile "*" stop >/dev/null 2>&1 || docker compose stop

# Settings first: .env holds the keys the other parts are encrypted with.
if [ -f "$WORK/config.tar.gz" ]; then
  [ -f .env ] && cp -p .env ".env.before-restore.$(date +%s)"
  tar -xzf "$WORK/config.tar.gz" -C . && say "Restored settings (.env, certificates, agent access)"
fi

if [ -f "$WORK/hermes-home.tar.gz" ]; then
  HH=$(grep -E '^HERMES_HOME_DIR=' .env 2>/dev/null | tail -1 | cut -d= -f2-); HH=${HH:-./data/hermes}
  mkdir -p "$HH" && tar -xzf "$WORK/hermes-home.tar.gz" -C "$HH" && say "Restored Hermes profiles, skills and sessions"
fi

if [ -f "$WORK/connectors.db" ]; then
  V=$(vol connectors-data)
  if [ -n "$V" ]; then
    docker run --rm -v "$V:/data" -v "$WORK:/in:ro" --entrypoint sh agent-os/connectors:0.1 \
      -c 'rm -f /data/connectors.db-wal /data/connectors.db-shm && cp /in/connectors.db /data/connectors.db' \
      && say "Restored dashboard connections"
  else note "connectors.db was not restored (no connectors volume found)"; fi
fi

if [ -f "$WORK/honcho.sql.gz" ]; then
  docker compose up -d honcho-db >/dev/null 2>&1
  for _ in $(seq 1 30); do docker exec agent-os-honcho-db pg_isready -U honcho >/dev/null 2>&1 && break; sleep 2; done
  docker exec agent-os-honcho-db psql -U honcho -d postgres -q -c 'DROP DATABASE IF EXISTS honcho WITH (FORCE)' -c 'CREATE DATABASE honcho' >/dev/null \
    && gunzip -c "$WORK/honcho.sql.gz" | docker exec -i agent-os-honcho-db psql -U honcho -d honcho -q >/dev/null 2>&1 \
    && say "Restored agent memory" || note "agent memory was not restored; the dump is $WORK/honcho.sql.gz"
fi

if [ -f "$WORK/paperclip-files.tar.gz" ]; then
  V=$(vol paperclip-data)
  if [ -n "$V" ]; then
    docker run --rm -v "$V:/paperclip" -v "$WORK:/in:ro" --entrypoint sh agent-os/connectors:0.1 \
      -c 'mkdir -p /paperclip/instances/default && tar -xzf /in/paperclip-files.tar.gz -C /paperclip/instances/default' \
      && say "Restored the team's files and keys"
  else note "Paperclip files were not restored (no paperclip volume found)"; fi
fi

say "Starting services"
docker compose --profile "*" up -d >/dev/null 2>&1 || docker compose up -d

if [ -f "$WORK/n8n.tar.gz" ] && docker ps --format '{{.Names}}' | grep -qx agent-os-n8n; then
  sleep 20
  docker exec agent-os-n8n sh -c 'rm -rf /tmp/aosrs && mkdir -p /tmp/aosrs' \
    && docker exec -i agent-os-n8n tar -xzf - -C /tmp/aosrs < "$WORK/n8n.tar.gz" \
    && docker exec agent-os-n8n sh -c 'n8n import:credentials --separate --input=/tmp/aosrs/credentials >/dev/null 2>&1; n8n import:workflow --separate --input=/tmp/aosrs/workflows >/dev/null 2>&1; rc=$?; rm -rf /tmp/aosrs; exit $rc' \
    && say "Restored automations (workflows come back switched off; turn on the ones you want)" \
    || note "automations were not restored; the export is $WORK/n8n.tar.gz"
fi

if [ -f "$WORK/paperclip-db.sql.gz" ]; then
  note "The team database (tasks, agents, routines) is NOT loaded automatically yet. The dump is $WORK/paperclip-db.sql.gz; see docs/RUNBOOK.md, Backups, for the steps."
fi

say ""
say "Restore finished."
[ -n "$NOTES" ] && printf 'Still to do by hand:%b\n' "$NOTES"
say "The unpacked copy holds secrets. Delete it when you are done: rm -rf $WORK"
