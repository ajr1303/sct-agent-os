#!/usr/bin/env bash
# Carries out requests made from the dashboard that need the host (cron, every minute).
# Four things today: keeping the proxy's two-step sign-in switch in step with the
# dashboard, "Update now" (see scripts/update-requested.sh), a dashboard password
# change or reset (see scripts/dashboard-password.sh), and "Link my team", which runs
# scripts/paperclip-connect.sh. The dashboard leaves
# data/backup/link-paperclip (optionally holding the owner's email); the outcome goes
# to data/backup/link-result.json for the page to show.
set -u
cd "$(dirname "$0")/.." || exit 1

# --- Two-step sign-in: make the proxy match what the owner chose ---------------------
# The dashboard writes data/backup/mfa-state ("on" or "off"). "on" means the proxy must
# ask for a code before serving anything; that is done by two small include files.
mfa_sync() {
  local want have gate=data/proxy
  want=$(head -n1 data/backup/mfa-state 2>/dev/null | tr -cd 'a-z'); [ "$want" = on ] || want=off
  if [ -f "$gate/mfa-gate-page.inc" ] && [ -f "$gate/mfa-gate-api.inc" ]; then have=on; else have=off; fi
  if [ "$want" = "$have" ]; then
    [ "$(cat data/backup/mfa-applied 2>/dev/null)" = "$have" ] || echo "$have" > data/backup/mfa-applied
    return 0
  fi
  docker ps --format '{{.Names}}' | grep -qx agent-os-proxy || return 0
  mkdir -p "$gate"
  if [ "$want" = on ]; then
    printf 'auth_request /_mfa_check;\nerror_page 401 = @mfa_page;\n' > "$gate/mfa-gate-page.inc"
    printf 'auth_request /_mfa_check;\nerror_page 401 = @mfa_api;\n' > "$gate/mfa-gate-api.inc"
  else
    rm -f "$gate"/mfa-gate-*.inc
  fi
  if docker exec agent-os-proxy nginx -t >/dev/null 2>&1; then
    docker exec agent-os-proxy nginx -s reload >/dev/null 2>&1 && echo "$want" > data/backup/mfa-applied
  else
    # Never leave the proxy with a config it cannot load.
    rm -f "$gate"/mfa-gate-*.inc
    docker exec agent-os-proxy nginx -s reload >/dev/null 2>&1
    echo "error" > data/backup/mfa-applied
  fi
}
mfa_sync

# --- "Update now" ---------------------------------------------------------------------
# The dashboard leaves data/backup/update-request. The update runs on its own in the
# background (it takes minutes and restarts the services), so this job stays quick.
update_requested() {
  local req=data/backup/update-request state=data/backup/update-state.json lock=data/backup/.update.lock
  # An update that died without finishing (a reboot, say) must not read "running" forever.
  if grep -q '"state": "running"' "$state" 2>/dev/null && flock -n "$lock" true 2>/dev/null; then
    sed -i 's/"state": "running"/"state": "failed"/' "$state"
  fi
  [ -f "$req" ] || return 0
  rm -f "$req"
  [ -x scripts/update-requested.sh ] || return 0
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup ./scripts/update-requested.sh >/dev/null 2>&1 < /dev/null &
  else
    nohup ./scripts/update-requested.sh >/dev/null 2>&1 < /dev/null &
  fi
}
update_requested

# --- Sign-in name, for the Account page to show (not a secret) -------------------------
if [ -f .env ] && [ -d data/backup ]; then
  signin=$(grep -m1 '^DASHBOARD_USER=' .env | cut -d= -f2-); [ -n "$signin" ] || signin="admin"
  [ "$(cat data/backup/dashboard-user 2>/dev/null)" = "$signin" ] || printf '%s\n' "$signin" > data/backup/dashboard-user
fi

# --- Dashboard password change or reset ------------------------------------------------
if [ -f data/backup/password-request ] && [ -x scripts/dashboard-password.sh ]; then
  ./scripts/dashboard-password.sh --from-request
fi

REQ=data/backup/link-paperclip
RES=data/backup/link-result.json
[ -f "$REQ" ] || exit 0
email=$(head -n1 "$REQ" | tr -cd 'A-Za-z0-9._%+@-' | cut -c1-255)
rm -f "$REQ"
if [ -n "$email" ]; then out=$(./scripts/paperclip-connect.sh "$email" 2>&1); else out=$(./scripts/paperclip-connect.sh 2>&1); fi
rc=$?
if [ $rc = 0 ]; then
  msg="Linked."
  # The owner account exists now, so nobody else needs to be able to create one.
  # Takes effect the next time the team service restarts (the next update).
  grep -q '^PAPERCLIP_DISABLE_SIGNUP=' .env 2>/dev/null || echo "PAPERCLIP_DISABLE_SIGNUP=true" >> .env
elif printf '%s' "$out" | grep -q "More than one Paperclip account"; then
  msg="More than one account exists in Paperclip. Enter the owner's email address and try again."
elif printf '%s' "$out" | grep -qi "no .*account\|no user\|not found"; then
  msg="No owner account found yet. Open Paperclip, create your account, then try again."
else
  msg="Linking did not work. Open Paperclip and make sure you have created your owner account, then try again."
fi
printf '{"ok": %s, "message": "%s", "at": "%s"}\n' "$([ $rc = 0 ] && echo true || echo false)" "$msg" "$(date -u +%FT%TZ)" > "$RES"
