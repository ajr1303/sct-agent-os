#!/bin/sh
# Agent OS: send this computer's resources and Veeam Agent results to the My devices page.
# Reads only. Runs as root from cron every 5 minutes.
set -u
DIR=$(dirname "$0")
# shellcheck disable=SC1091
. "$DIR/config"
esc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

HOST=$(hostname 2>/dev/null || echo unknown)
OSN=$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-Linux}" || printf 'Linux')
OSN="$OSN $(uname -r)"
UP=$(cut -d. -f1 /proc/uptime)
cpu_line() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }
A=$(cpu_line); sleep 1; B=$(cpu_line)
CPU=$(printf '%s %s\n' "$A" "$B" | awk '{t=$3-$1; i=$4-$2; if (t>0) printf "%.0f", 100*(t-i)/t; else print 0}')
MT=$(awk '/^MemTotal:/{printf "%.0f", $2*1024}' /proc/meminfo)
MF=$(awk '/^MemAvailable:/{printf "%.0f", $2*1024}' /proc/meminfo)
REBOOT=false; [ -f /var/run/reboot-required ] && REBOOT=true
DISKS=$(df -P -k 2>/dev/null | awk 'NR>1 && $1 ~ /^\/dev\// && $1 !~ /^\/dev\/loop/ && !seen[$1]++ {
  gsub(/["\\]/, "", $6); printf "%s{\"name\":\"%s\",\"size\":%.0f,\"free\":%.0f}", (n++ ? "," : ""), $6, $2*1024, $4*1024 }')

VEEAM='{"installed":false}'
if command -v veeamconfig >/dev/null 2>&1; then
  VER=$(veeamconfig -v 2>/dev/null | head -1)
  SVC=$(systemctl is-active veeamservice 2>/dev/null || echo unknown)
  SESS=""
  LIST=$(veeamconfig session list 2>/dev/null | grep '{' | tail -60) || LIST=""
  OLDIFS=$IFS; IFS='
'
  for L in $LIST; do SESS="$SESS${SESS:+,}\"$(esc "$L")\""; done
  IFS=$OLDIFS
  VEEAM="{\"installed\":true,\"version\":\"$(esc "$VER")\",\"service\":\"$(esc "$SVC")\",\"sessions\":[$SESS]}"
fi

BODY="{\"host\":\"$(esc "$HOST")\",\"os_name\":\"$(esc "$OSN")\",\"uptime_s\":$UP,\"cpu\":${CPU:-0},\"mem_total\":${MT:-0},\"mem_free\":${MF:-0},\"reboot_pending\":$REBOOT,\"tz\":\"$(date +%z)\",\"disks\":[$DISKS],\"veeam\":$VEEAM}"
printf '%s' "$BODY" | curl -fsS -m 30 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @- "$URL" >/dev/null
