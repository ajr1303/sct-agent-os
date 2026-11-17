#!/usr/bin/env bash
# Set the dashboard password.
#
#   sudo ./scripts/dashboard-password.sh            make a new random password and show it
#   sudo ./scripts/dashboard-password.sh --ask      type the new password yourself
#   ./scripts/dashboard-password.sh --from-request  (used by scripts/host-requests.sh for
#                                                    the Security page and the reset page)
#
# The password lives in .env as DASHBOARD_PASSWORD. Changing it restarts the dashboard
# for about a minute. Agents, automations and memory keep running.
main() {
  set -u
  cd "$(dirname "$0")/.." || exit 1
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  local req=data/backup/password-request res=data/backup/password-result.json

  valid() {   # 12 to 128 characters from a set that is safe in .env
    local p=$1
    [ "${#p}" -ge 12 ] && [ "${#p}" -le 128 ] || return 1
    case "$p" in *[!A-Za-z0-9'!@%^*()_+.,:;?~-']*) return 1 ;; esac
    return 0
  }
  current() { grep -m1 '^DASHBOARD_PASSWORD=' .env 2>/dev/null | cut -d= -f2-; }
  valid_user() {   # 3 to 64 characters: letters, numbers and . _ @ -
    local u=$1
    [ "${#u}" -ge 3 ] && [ "${#u}" -le 64 ] || return 1
    case "$u" in *[!A-Za-z0-9._@-]*) return 1 ;; esac
    return 0
  }
  apply() {   # apply <new password> [new sign-in name]; either may be empty to keep it.
              # Returns non-zero if the dashboard did not come back.
    local new=$1 user=${2:-} tmp=.env.pw.$$
    [ -n "$new" ] || new=$(current)
    ( umask 077
      if [ -n "$user" ]; then grep -v -e '^DASHBOARD_PASSWORD=' -e '^DASHBOARD_USER=' .env > "$tmp"; printf 'DASHBOARD_USER=%s\n' "$user" >> "$tmp"
      else grep -v '^DASHBOARD_PASSWORD=' .env > "$tmp"; fi
      printf 'DASHBOARD_PASSWORD=%s\n' "$new" >> "$tmp" ) || { rm -f "$tmp"; return 1; }
    chmod --reference=.env "$tmp" 2>/dev/null; chown --reference=.env "$tmp" 2>/dev/null
    mv "$tmp" .env || return 1
    local had_flag=0; [ -f data/.maintenance ] && had_flag=1
    mkdir -p data && touch data/.maintenance
    docker compose up -d hermes >/dev/null 2>&1 || { [ $had_flag = 1 ] || rm -f data/.maintenance; return 1; }
    docker compose restart proxy >/dev/null 2>&1
    ./scripts/enable-plugins.sh >/dev/null 2>&1 || true
    [ $had_flag = 1 ] || rm -f data/.maintenance
    return 0
  }
  result() {  # result <id> <true|false> <message>
    printf '{"id": "%s", "ok": %s, "message": "%s", "at": "%s"}\n' "$1" "$2" "$3" "$(date -u +%FT%TZ)" > "$res.tmp" && mv "$res.tmp" "$res"
  }

  case "${1:-}" in
  --from-request)
    [ -f "$req" ] || exit 0
    local mode id cur_b64 new_b64 user_b64 cur new user
    mode=$(sed -n 1p "$req" | tr -cd 'a-z'); id=$(sed -n 2p "$req" | tr -cd 'a-f0-9' | cut -c1-64)
    cur_b64=$(sed -n 3p "$req"); new_b64=$(sed -n 4p "$req"); user_b64=$(sed -n 5p "$req")
    rm -f "$req"
    [ -n "$id" ] || exit 0
    cur=$(printf '%s' "$cur_b64" | base64 -d 2>/dev/null); new=$(printf '%s' "$new_b64" | base64 -d 2>/dev/null)
    user=$(printf '%s' "$user_b64" | base64 -d 2>/dev/null)
    if [ -f data/backup/.update.lock ] && ! flock -n data/backup/.update.lock true 2>/dev/null; then
      result "$id" false "An update is running. Try again when it has finished."; exit 0
    fi
    if [ "$mode" = change ] || [ "$mode" = verify ]; then
      if [ -z "$cur" ] || [ "$cur" != "$(current)" ]; then
        result "$id" false "The current password is not right."; exit 0
      fi
    elif [ "$mode" != reset ]; then
      exit 0
    fi
    if [ "$mode" = verify ]; then result "$id" true "Checked."; exit 0; fi
    [ "$mode" = change ] || user=""          # a reset never changes the sign-in name
    if [ -z "$new" ] && [ -z "$user" ]; then result "$id" false "Nothing to change."; exit 0; fi
    if [ -n "$new" ] && ! valid "$new"; then result "$id" false "That password cannot be used. Use 12 or more letters, numbers and these symbols: ! @ % ^ * ( ) _ + . , : ; ? ~ -"; exit 0; fi
    if [ -n "$user" ] && ! valid_user "$user"; then result "$id" false "That sign-in name cannot be used. Use 3 to 64 letters, numbers and . _ @ -"; exit 0; fi
    if apply "$new" "$user"; then result "$id" true "Saved."
    else result "$id" false "The password was saved but the dashboard did not restart cleanly. Ask whoever looks after the server to check it."; fi
    ;;
  --ask)
    [ -f .env ] || { echo "No .env here. Run this from the Agent OS folder."; exit 1; }
    local a b
    printf 'New dashboard password: '; read -rs a; echo
    printf 'Again: '; read -rs b; echo
    [ "$a" = "$b" ] || { echo "Those did not match. Nothing was changed."; exit 1; }
    valid "$a" || { echo "Use 12 or more letters, numbers and these symbols: ! @ % ^ * ( ) _ + . , : ; ? ~ -"; echo "Nothing was changed."; exit 1; }
    apply "$a" || { echo "The password was saved but the dashboard did not restart cleanly. Check: docker compose ps"; exit 1; }
    echo "Dashboard password changed. Sign in as admin with the new password."
    ;;
  "")
    [ -f .env ] || { echo "No .env here. Run this from the Agent OS folder."; exit 1; }
    local gen
    gen=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | cut -c1-20)
    valid "$gen" || { echo "Could not make a password. Nothing was changed."; exit 1; }
    apply "$gen" || { echo "The password was saved but the dashboard did not restart cleanly. Check: docker compose ps"; exit 1; }
    echo "Dashboard password changed. Sign in as admin with:"
    echo "  $gen"
    echo "Give it to the owner in person or by phone, and ask them to change it on the Security page."
    ;;
  *) echo "Usage: $0 [--ask]"; exit 1 ;;
  esac
}
main "$@"; exit
