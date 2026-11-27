#!/bin/sh
# Agent OS: make this Linux computer report to the My devices page every 5 minutes.
# Run once as root. To undo: rm -rf /opt/agent-os-report /etc/cron.d/agent-os-report
set -eu
BASE='__BASE__'; TOKEN='__TOKEN__'
[ "$(id -u)" = "0" ] || { echo "Run this as root (put sudo before sh)."; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Install curl first, then run the command again."; exit 1; }
DIR=/opt/agent-os-report
mkdir -p "$DIR"; chmod 700 "$DIR"
curl -fsSL "$BASE/api/connectors/devices/reporter/$TOKEN/report.sh" -o "$DIR/report.sh"
chmod 700 "$DIR/report.sh"
# Only root may read this: it holds this computer's report token.
( umask 077; printf 'URL=%s\nTOKEN=%s\n' "$BASE/api/connectors/devices/report" "$TOKEN" > "$DIR/config" )
if [ -d /etc/cron.d ]; then
  printf '*/5 * * * * root %s >/dev/null 2>&1\n' "$DIR/report.sh" > /etc/cron.d/agent-os-report
  chmod 644 /etc/cron.d/agent-os-report
else
  ( crontab -l 2>/dev/null | grep -v agent-os-report || true; echo "*/5 * * * * $DIR/report.sh >/dev/null 2>&1" ) | crontab -
fi
if "$DIR/report.sh"; then
  echo "Done. This computer now reports to Agent OS every 5 minutes. Look at My devices."
else
  echo "Installed, but the first report failed. Check this computer can open $BASE ."
fi
