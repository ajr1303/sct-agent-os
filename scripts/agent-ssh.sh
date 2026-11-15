#!/usr/bin/env bash
# Give this server SSH access to a machine that runs one of your agents, so the
# dashboard can change that agent's model (Agents page). Linux machines only.
#
#   sudo ./scripts/agent-ssh.sh add <user>@<host>     install the key, check the machine
#   sudo ./scripts/agent-ssh.sh list                  machines this server can reach
#   sudo ./scripts/agent-ssh.sh remove <host>         forget a machine (key stays on it)
#
# <host> must be the same name the agent's gateway address uses in Paperclip.
# The key lives in data/agent-ssh/ (root only) and is mounted read-only into the
# dashboard's backend. It is used for one thing: Hermes' own command to set the
# model, followed by a gateway restart. `add` asks for that machine's password once.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
D=data/agent-ssh; KEY=$D/id_ed25519; KH=$D/known_hosts; HOSTS=$D/hosts.json
[ "$(id -u)" = 0 ] || { echo "Run with sudo (the key is readable by root only)."; exit 1; }
mkdir -p "$D" && chmod 700 "$D"
[ -f "$HOSTS" ] || echo '{}' > "$HOSTS"
SSHO=(-i "$KEY" -o "UserKnownHostsFile=$KH" -o IdentitiesOnly=yes -o ConnectTimeout=15)

case "${1:-}" in
  list)
    python3 - "$HOSTS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if not d: print("No machines added yet.")
for h, e in sorted(d.items()):
    print("%-44s %s | service %s (%s) | set model: %s | restart: %s" % (h, e.get("target"), e.get("service"), e.get("scope"),
          "yes" if e.get("can_set") else "NO", "yes" if e.get("can_restart") else "NO"))
PY
    ;;
  remove)
    H="${2:?host}"; python3 - "$HOSTS" "$H" <<'PY'
import json, sys
p, h = sys.argv[1], sys.argv[2].lower(); d = json.load(open(p))
print("Removed " + h if d.pop(h, None) else "No such machine: " + h); json.dump(d, open(p, "w"), indent=1)
PY
    ;;
  add)
    T="${2:?user@host}"; case "$T" in *@*) ;; *) echo "Give it as <user>@<host>."; exit 1;; esac
    HOST="${T#*@}"; HOST="$(printf %s "$HOST" | tr '[:upper:]' '[:lower:]')"
    command -v ssh-copy-id >/dev/null || { echo "ssh-copy-id is not installed on this server (package: openssh-client)."; exit 1; }
    [ -f "$KEY" ] || { ssh-keygen -q -t ed25519 -N "" -C "agent-os" -f "$KEY" && echo "Created this server's agent SSH key."; }
    chmod 600 "$KEY"
    echo "Installing the key on $T (you will be asked for that machine's password once)..."
    ssh-copy-id -i "$KEY.pub" -o "UserKnownHostsFile=$KH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$T" >/dev/null 2>&1 \
      || ssh-copy-id -i "$KEY.pub" -o "UserKnownHostsFile=$KH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$T" \
      || { echo "Could not install the key on $T."; exit 1; }
    OUT=$(ssh "${SSHO[@]}" -o BatchMode=yes -o StrictHostKeyChecking=yes "$T" 'bash -s' <<'REMOTE'
svc=""; scope=""
for s in hermes-gateway.service hgw.service; do
  if systemctl --user is-active --quiet "$s" 2>/dev/null; then svc=$s; scope=user; break; fi
done
if [ -z "$svc" ]; then for s in hermes-gateway.service hgw.service; do
  if systemctl is-active --quiet "$s" 2>/dev/null; then svc=$s; scope=system; break; fi
done; fi
echo "service=$svc"; echo "scope=$scope"
# Find the hermes command: on the path, in the usual per-user spot, or wherever the
# gateway service itself starts it from.
H=$(command -v hermes 2>/dev/null || true); [ -x "$H" ] || H="$HOME/.local/bin/hermes"
EXEC=""
if [ -n "$svc" ]; then
  if [ "$scope" = user ]; then EXEC=$(systemctl --user cat "$svc" 2>/dev/null | sed -n 's/^ExecStart=//p' | head -1)
  else EXEC=$(systemctl cat "$svc" 2>/dev/null | sed -n 's/^ExecStart=//p' | head -1); fi
fi
if [ ! -x "$H" ]; then for t in $EXEC; do case "$t" in */hermes) [ -x "$t" ] && H="$t";; esac; done; fi
echo "hermes=$([ -x "$H" ] && echo "$H")"
echo "hermes_version=$([ -x "$H" ] && "$H" --version 2>/dev/null | head -1 | tr -d '=' | cut -c1-60)"
echo "can_set=$([ -x "$H" ] && "$H" config set --help >/dev/null 2>&1 && echo 1 || echo 0)"
echo "execstart=$(printf %s "$EXEC" | tr -d '=' | cut -c1-160)"
if [ "$scope" = user ]; then echo "can_restart=1"
elif [ -n "$svc" ] && sudo -n -l "$(command -v systemctl)" restart "$svc" >/dev/null 2>&1; then echo "can_restart=1"
else echo "can_restart=0"; fi
echo "user=$(id -un)"; echo "systemctl=$(command -v systemctl)"
REMOTE
    ) || { echo "The key was installed but logging in with it failed."; exit 1; }
    AOS_OUT="$OUT" python3 - "$HOSTS" "$HOST" "$T" <<'PY'
import json, os, sys
p, host, target = sys.argv[1:4]
kv = dict(l.split("=", 1) for l in os.environ.get("AOS_OUT", "").splitlines() if "=" in l)
e = {"target": target, "service": kv.get("service") or "", "scope": kv.get("scope") or "", "hermes": kv.get("hermes") or "",
     "can_set": kv.get("can_set") == "1", "can_restart": kv.get("can_restart") == "1" and bool(kv.get("service"))}
d = json.load(open(p)); d[host] = e; json.dump(d, open(p, "w"), indent=1)
print("Added %s: gateway service %s (%s)" % (host, e["service"] or "NOT FOUND", e["scope"] or "-"))
if kv.get("hermes"): print("  Hermes: %s (%s)" % (kv["hermes"], kv.get("hermes_version") or "version unknown"))
if not kv.get("hermes"): print("  ! The hermes command was not found on that machine. Its gateway starts with: " + (kv.get("execstart") or "unknown"))
elif not e["can_set"]: print("  ! That Hermes version has no 'config set' command, so its model cannot be changed from here.")
if not e["service"]: print("  ! No running Hermes gateway service was found (looked for hermes-gateway.service and hgw.service).")
elif not e["can_restart"]:
    print("  ! This server cannot restart that gateway without a password. To allow only that, run on the machine:")
    print("      echo '%s ALL=(root) NOPASSWD: %s restart %s' | sudo tee /etc/sudoers.d/agent-os-gateway && sudo chmod 440 /etc/sudoers.d/agent-os-gateway"
          % (kv.get("user", "<user>"), kv.get("systemctl") or "/usr/bin/systemctl", e["service"]))
    print("    then run this add command again.")
if e["can_set"] and e["can_restart"]: print("  Ready: the Agents page can change this agent's model.")
PY
    chmod 600 "$HOSTS" "$KH" 2>/dev/null || true
    ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1;;
esac
