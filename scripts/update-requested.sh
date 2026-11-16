#!/usr/bin/env bash
# "Update now" from the dashboard. scripts/host-requests.sh starts this in the
# background when the owner presses the button; it runs the normal updater (which
# takes a backup first) and records how it went in data/backup/update-state.json for
# the dashboard to show. Output goes to data/backup/update.log.
#
# Everything is inside main() so bash has read the whole file before the updater
# replaces it with the new version.
main() {
  set -u
  cd "$(dirname "$0")/.." || exit 1
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export HOME="${HOME:-/root}"
  local state=data/backup/update-state.json log=data/backup/update.log
  local from to started result
  mkdir -p data/backup
  exec 9> data/backup/.update.lock
  flock -n 9 || exit 0          # one update at a time

  ver() { tr -cd '0-9.' < VERSION 2>/dev/null | cut -c1-20; }
  record() {   # record <state> [finished_at]
    printf '{"state": "%s", "from": "%s", "to": "%s", "started_at": "%s", "finished_at": "%s"}\n' \
      "$1" "$from" "$to" "$started" "${2:-}" > "$state.tmp" && mv "$state.tmp" "$state"
  }
  from=$(ver); to=""; started=$(date -u +%FT%TZ)
  record running
  if timeout 5400 ./scripts/update.sh > "$log" 2>&1 9>&-; then result="done"; else result="failed"; fi
  chmod 600 "$log" 2>/dev/null
  to=$(ver)
  record "$result" "$(date -u +%FT%TZ)"
}
main "$@"; exit
