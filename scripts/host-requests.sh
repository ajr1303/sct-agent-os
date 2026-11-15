#!/usr/bin/env bash
# Carries out requests made from the dashboard that need the host (cron, every minute).
# Today: "Link my team", which runs scripts/paperclip-connect.sh. The dashboard leaves
# data/backup/link-paperclip (optionally holding the owner's email); the outcome goes
# to data/backup/link-result.json for the page to show.
set -u
cd "$(dirname "$0")/.." || exit 1
REQ=data/backup/link-paperclip
RES=data/backup/link-result.json
[ -f "$REQ" ] || exit 0
email=$(head -n1 "$REQ" | tr -cd 'A-Za-z0-9._%+@-' | cut -c1-255)
rm -f "$REQ"
if [ -n "$email" ]; then out=$(./scripts/paperclip-connect.sh "$email" 2>&1); else out=$(./scripts/paperclip-connect.sh 2>&1); fi
rc=$?
if [ $rc = 0 ]; then
  msg="Linked."
elif printf '%s' "$out" | grep -q "More than one Paperclip account"; then
  msg="More than one account exists in Paperclip. Enter the owner's email address and try again."
elif printf '%s' "$out" | grep -qi "no .*account\|no user\|not found"; then
  msg="No owner account found yet. Open Paperclip, create your account, then try again."
else
  msg="Linking did not work. Open Paperclip and make sure you have created your owner account, then try again."
fi
printf '{"ok": %s, "message": "%s", "at": "%s"}\n' "$([ $rc = 0 ] && echo true || echo false)" "$msg" "$(date -u +%FT%TZ)" > "$RES"
