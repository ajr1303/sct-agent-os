#!/usr/bin/env bash
# The optional built-in SIEM. Agent OS does not write its own: this sets up Wazuh
# (open source, wazuh.com) beside Agent OS from Wazuh's official Docker setup at a
# pinned version, with Agent OS's changes in siem/overrides.yml.
#
#   scripts/siem.sh on [--console]   set up (first time) and start
#   scripts/siem.sh off              stop; everything collected so far is kept
#   scripts/siem.sh status           print the state file
#
# "Turn on" on the dashboard's Security events page runs this through
# scripts/host-requests.sh. Progress and the outcome go to data/backup/siem-state.json;
# what the dashboard service needs to read alerts goes to data/backup/siem-conn.json.
#
# It needs real room: about 4 GB of memory on top of Agent OS and tens of GB of disk.
set -u
cd "$(dirname "$0")/.." || exit 1

WAZUH_VERSION=4.14.11
SRC=data/siem/src
DIR=$SRC/single-node
ENVF=data/siem/siem.env
STATE=data/backup/siem-state.json
CONN=data/backup/siem-conn.json
CA=data/backup/siem-ca.pem
LOG=data/siem/setup.log
LOCK=data/siem/.lock
MIN_RAM_KB=11500000      # Agent OS's own 8 GB plus the SIEM
MIN_DISK_GB=40

now() { date -u +%FT%TZ; }
json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n\r\t' '   '; }
STARTED=$(now); CONSOLE=false

state() { # state STATE "step or message"
  local tmp="$STATE.tmp"
  printf '{"state": "%s", "step": "%s", "version": "%s", "console": %s, "started_at": "%s", "at": "%s"}\n' \
    "$1" "$(json "${2:-}")" "$WAZUH_VERSION" "$CONSOLE" "$STARTED" "$(now)" > "$tmp" && mv "$tmp" "$STATE"
}
fail() { echo "FAILED: $1" >> "$LOG"; state failed "$1"; echo "siem: $1" >&2; exit 1; }
dc() { docker compose -p agent-os-siem --project-directory "$DIR" --env-file "$ENVF" -f "$DIR/docker-compose.yml" -f siem/overrides.yml "$@"; }
envval() { grep -m1 "^$1=" "$ENVF" 2>/dev/null | cut -d= -f2-; }
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }

preflight() {
  local ram disk mm ver
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed on this server."
  command -v git >/dev/null 2>&1 || fail "git is needed to download the SIEM. Install git and try again."
  ver=$(docker compose version --short 2>/dev/null | tr -d v)
  case "$ver" in
    ""|1.*|2.[0-9].*|2.1[0-9].*|2.2[0-3].*) fail "Docker Compose 2.24 or newer is needed (found ${ver:-none}). Update Docker and try again.";;
  esac
  docker network inspect agent-os_default >/dev/null 2>&1 || fail "Agent OS is not running. Start it first."
  ram=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  [ "$ram" -ge "$MIN_RAM_KB" ] || fail "The SIEM needs a server with at least 12 GB of memory (this one has about $((ram/1024/1024)) GB). Add memory, or run the SIEM on another server."
  disk=$(df -BG --output=avail . | tail -1 | tr -dc 0-9)
  [ "${disk:-0}" -ge "$MIN_DISK_GB" ] || fail "The SIEM needs at least $MIN_DISK_GB GB of free disk (found ${disk:-0} GB)."
  # The indexer will not start below this kernel setting.
  mm=$(sysctl -n vm.max_map_count 2>/dev/null || echo 0)
  if [ "$mm" -lt 262144 ]; then
    local sudo=""; [ "$(id -u)" = 0 ] || sudo="sudo -n"
    if $sudo sysctl -w vm.max_map_count=262144 >/dev/null 2>&1; then
      echo "vm.max_map_count=262144" | $sudo tee /etc/sysctl.d/99-agent-os-siem.conf >/dev/null 2>&1 || true
    else
      fail "One server setting has to be changed first. Run this once on the server, then turn the SIEM on again: sudo sysctl -w vm.max_map_count=262144 && echo vm.max_map_count=262144 | sudo tee /etc/sysctl.d/99-agent-os-siem.conf"
    fi
  fi
}

# Replace the password hash of one user in Wazuh's internal_users.yml.
set_hash() { # set_hash USER HASH FILE
  U="$1" H="$2" awk '
    $0 ~ "^" ENVIRON["U"] ":" { hit = 1; print; next }
    hit && /^  hash:/ { print "  hash: \"" ENVIRON["H"] "\""; hit = 0; done = 1; next }
    /^[^ #]/ { hit = 0 }
    { print }
    END { if (!done) exit 3 }' "$3" > "$3.tmp" && mv "$3.tmp" "$3"
}
hash_of() { # bcrypt, made by the indexer's own tool
  docker run --rm -e JAVA_HOME=/usr/share/wazuh-indexer/jdk -e OPENSEARCH_JAVA_HOME=/usr/share/wazuh-indexer/jdk --entrypoint bash "wazuh/wazuh-indexer:$WAZUH_VERSION" \
    /usr/share/wazuh-indexer/plugins/opensearch-security/tools/hash.sh -p "$1" 2>>"$LOG" | grep -m1 '^\$2'
}

first_setup() {
  local ipw apw dpw epw h conf
  state installing "Downloading the SIEM"
  rm -rf "$SRC"
  git clone -q --depth 1 -b "v$WAZUH_VERSION" https://github.com/wazuh/wazuh-docker "$SRC" >>"$LOG" 2>&1 \
    || fail "Could not download the SIEM. Check this server's internet connection and try again."
  [ -f "$DIR/docker-compose.yml" ] && [ -f "$DIR/config/wazuh_indexer/internal_users.yml" ] \
    || fail "The SIEM download does not look as expected (Wazuh $WAZUH_VERSION)."

  # The API insists on upper, lower, a digit and a symbol.
  ipw=$(rand 28); apw="Aos.$(rand 24)9a"; dpw=$(rand 28); epw=$(rand 24)
  [ ${#ipw} -ge 20 ] && [ ${#epw} -ge 20 ] || fail "Could not make passwords on this server."

  state installing "Downloading the SIEM's parts (this is the long step)"
  docker pull -q "wazuh/wazuh-indexer:$WAZUH_VERSION" >>"$LOG" 2>&1 || fail "Could not download the SIEM's indexer image."

  state installing "Setting passwords"
  h=$(hash_of "$ipw"); [ -n "$h" ] || fail "Could not prepare the SIEM's passwords (hashing failed). Nothing was started."
  set_hash admin "$h" "$DIR/config/wazuh_indexer/internal_users.yml" || fail "Could not set the SIEM's admin password. Nothing was started."
  h=$(hash_of "$dpw"); [ -n "$h" ] || fail "Could not prepare the SIEM's passwords (hashing failed). Nothing was started."
  set_hash kibanaserver "$h" "$DIR/config/wazuh_indexer/internal_users.yml" || fail "Could not set the SIEM's console password. Nothing was started."
  # Wazuh's own dashboard keeps the API password in a file.
  P="$apw" awk '/^ *password:/ { sub(/password:.*/, "password: \"" ENVIRON["P"] "\"") } { print }' \
    "$DIR/config/wazuh_dashboard/wazuh.yml" > "$DIR/config/wazuh_dashboard/wazuh.yml.tmp" \
    && mv "$DIR/config/wazuh_dashboard/wazuh.yml.tmp" "$DIR/config/wazuh_dashboard/wazuh.yml"

  # Manager: take syslog from private addresses, and ask computers for a password to enrol.
  conf="$DIR/config/wazuh_cluster/wazuh_manager.conf"
  grep -q '<connection>syslog</connection>' "$conf" || awk '
    { print }
    /<\/remote>/ && !done {
      print ""
      print "  <!-- Agent OS: syslog from network gear (firewalls, switches, access points). -->"
      print "  <remote>"
      print "    <connection>syslog</connection>"
      print "    <port>514</port>"
      print "    <protocol>udp</protocol>"
      print "    <allowed-ips>10.0.0.0/8</allowed-ips>"
      print "    <allowed-ips>172.16.0.0/12</allowed-ips>"
      print "    <allowed-ips>192.168.0.0/16</allowed-ips>"
      print "    <allowed-ips>100.64.0.0/10</allowed-ips>"
      print "  </remote>"
      done = 1 }' "$conf" > "$conf.tmp" && mv "$conf.tmp" "$conf"
  grep -q '<connection>syslog</connection>' "$conf" || fail "Could not prepare the SIEM's settings (syslog)."
  sed -i 's|<use_password>no</use_password>|<use_password>yes</use_password>|' "$conf"
  grep -q '<use_password>yes</use_password>' "$conf" || fail "Could not prepare the SIEM's settings (enrolment password)."
  printf '%s\n' "$epw" > "$DIR/config/authd.pass"; chmod 640 "$DIR/config/authd.pass"

  umask 077
  { echo "SIEM_INDEXER_PASSWORD=$ipw"; echo "SIEM_API_PASSWORD=$apw"; echo "SIEM_DASHBOARD_PASSWORD=$dpw"
    echo "SIEM_ENROL_PASSWORD=$epw"; echo "SIEM_VERSION=$WAZUH_VERSION"; } > "$ENVF"
  umask 022

  state installing "Making certificates"
  docker compose -p agent-os-siem --project-directory "$DIR" -f "$DIR/generate-indexer-certs.yml" run --rm generator >>"$LOG" 2>&1 \
    || fail "Could not make the SIEM's certificates."
  touch data/siem/.setup-done
}

write_conn() {
  local host
  host=$(hostname -I 2>/dev/null | awk '{print $1}')
  docker run --rm --entrypoint cat -v "$(pwd)/$DIR/config/wazuh_indexer_ssl_certs:/c:ro" "wazuh/wazuh-indexer:$WAZUH_VERSION" /c/root-ca.pem > "$CA.tmp" 2>>"$LOG" \
    && grep -q 'BEGIN CERTIFICATE' "$CA.tmp" && mv "$CA.tmp" "$CA" || fail "Could not read the SIEM's certificate."
  chmod 600 "$CA"
  umask 077
  printf '{"indexer_url": "https://wazuh.indexer:9200", "indexer_user": "admin", "indexer_password": "%s", "api_url": "https://wazuh.manager:55000", "api_user": "wazuh-wui", "api_password": "%s", "enrol_password": "%s", "ca": "siem-ca.pem", "host": "%s", "hostname": "%s", "console_port": "%s"}\n' \
    "$(envval SIEM_INDEXER_PASSWORD)" "$(envval SIEM_API_PASSWORD)" "$(envval SIEM_ENROL_PASSWORD)" "$(json "$host")" "$(json "$(hostname)")" \
    "$(envval SIEM_CONSOLE_PORT | tr -dc 0-9)" > "$CONN.tmp" && mv "$CONN.tmp" "$CONN"
  umask 022
}

# Ask the indexer, from the dashboard service's side, whether our password works.
# Prints the HTTP status (000 when it cannot be reached).
probe() {
  docker exec -e P="$(envval SIEM_INDEXER_PASSWORD)" agent-os-connectors python3 -c '
import os, httpx
try:
    print(httpx.get("https://wazuh.indexer:9200/", auth=("admin", os.environ["P"]), verify="/backup-config/siem-ca.pem", timeout=8).status_code)
except Exception:
    print("000")' 2>/dev/null || echo 000
}

turn_on() {
  mkdir -p data/siem data/backup
  : >> "$LOG"
  preflight
  [ -f data/siem/.setup-done ] && [ -f "$ENVF" ] && [ -f "$DIR/docker-compose.yml" ] || first_setup
  WAZUH_VERSION=$(envval SIEM_VERSION); WAZUH_VERSION=${WAZUH_VERSION:-4.14.11}   # what is installed, not what is newest
  state installing "Starting the SIEM"
  local prof=""; [ "$CONSOLE" = true ] && prof="--profile console"
  # shellcheck disable=SC2086
  local out
  out=$(dc $prof up -d 2>&1); local rc=$?
  printf '%s\n' "$out" >> "$LOG"
  [ $rc = 0 ] || fail "The SIEM did not start: $(printf '%s' "$out" | grep -v '^ *$' | tail -n 2 | tr '\n' ' ' | cut -c1-300)"
  write_conn

  state installing "Waiting for the SIEM to come up (a few minutes the first time)"
  local i code=000 fixed=0
  for i in $(seq 1 90); do
    code=$(probe)
    [ "$code" = 200 ] && break
    # Reachable but our password is refused: the indexer has not loaded its user list. Load it once.
    if [ "$code" = 401 ] && [ "$fixed" = 0 ] && [ "$i" -ge 6 ]; then
      fixed=1
      dc exec -T wazuh.indexer bash -c 'export JAVA_HOME=/usr/share/wazuh-indexer/jdk; D=/usr/share/wazuh-indexer; bash $D/plugins/opensearch-security/tools/securityadmin.sh -cd $D/config/opensearch-security/ -nhnv -cacert $D/config/certs/root-ca.pem -cert $D/config/certs/admin.pem -key $D/config/certs/admin-key.pem -p 9200 -icl' >>"$LOG" 2>&1 || true
    fi
    sleep 10
  done
  if [ "$code" != 200 ]; then
    dc --profile console stop >>"$LOG" 2>&1
    [ "$code" = 401 ] && fail "The SIEM started but would not accept its new password, so it was stopped again. See data/siem/setup.log."
    fail "The SIEM did not come up in 15 minutes, so it was stopped. See data/siem/setup.log; low memory is the usual cause."
  fi
  state running "Collecting"
  echo "SIEM is running (Wazuh $WAZUH_VERSION). Open Security events on the dashboard for how to send logs to it."
}

turn_off() {
  [ -f "$ENVF" ] && [ -f "$DIR/docker-compose.yml" ] || { rm -f "$STATE" "$CONN"; echo "The SIEM is not set up."; return 0; }
  WAZUH_VERSION=$(envval SIEM_VERSION); WAZUH_VERSION=${WAZUH_VERSION:-4.14.11}
  dc --profile console stop >>"$LOG" 2>&1 || fail "Could not stop the SIEM."
  state stopped "Stopped. What it collected is kept."
  echo "SIEM stopped. Its data is kept; turn it on again any time."
}

cmd=${1:-status}; shift || true
for a in "$@"; do [ "$a" = "--console" ] && CONSOLE=true; done
case "$cmd" in
  on|off)
    mkdir -p data/siem
    exec 9>"$LOCK"; flock -n 9 || { echo "The SIEM is already being set up or stopped."; exit 0; }
    if [ "$cmd" = on ]; then turn_on; else turn_off; fi;;
  status) cat "$STATE" 2>/dev/null || echo '{"state": "off"}';;
  *) echo "Usage: scripts/siem.sh on [--console] | off | status"; exit 2;;
esac
