#!/usr/bin/env bash
# Install (or refresh) every scheduled job Agent OS needs. Safe to run any number of
# times: it replaces only the lines it manages (marked "# agent-os-managed") and
# leaves the rest of the crontab alone. Used by install.sh and update.sh.
set -u
cd "$(dirname "$0")/.." || exit 1
here=$(pwd)
if ! command -v crontab >/dev/null 2>&1; then
  echo "  ! crontab not found: the watchdog, nightly backup and update check are NOT scheduled."
  echo "    Install cron (apt: cron / dnf: cronie), then run: $here/scripts/install-cron.sh"
  exit 1
fi
{ crontab -l 2>/dev/null | grep -v '# agent-os-managed' || true
  echo "*/5 * * * * $here/scripts/watchdog.sh # agent-os-managed"
  echo "30 3 * * * $here/scripts/backup.sh >/dev/null 2>&1 # agent-os-managed"
  echo "*/5 * * * * $here/scripts/backup.sh --if-requested >/dev/null 2>&1 # agent-os-managed"
  echo "* * * * * $here/scripts/host-requests.sh >/dev/null 2>&1 # agent-os-managed"
  echo "17 */6 * * * $here/scripts/check-updates.sh # agent-os-managed"
  echo "*/30 * * * * $here/scripts/agent-models.sh >/dev/null 2>&1 # agent-os-managed"; } | crontab -
