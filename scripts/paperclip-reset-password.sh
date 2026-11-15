#!/usr/bin/env bash
# Reset a Paperclip login password (Paperclip has no "forgot password" flow).
# Run on the box:  sudo ./scripts/paperclip-reset-password.sh
# You type the new password at a hidden prompt — it never appears on screen, in
# shell history, in process arguments, or in any file.
set -euo pipefail
cd "$(dirname "$0")/.."

IN=/tmp/pcreset.$$.mjs
cleanup() { docker compose exec -T paperclip rm -f "$IN" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker compose cp scripts/lib/paperclip-reset-password.mjs "paperclip:$IN" >/dev/null

echo "Paperclip accounts:"
docker compose exec -T paperclip node "$IN" --list </dev/null

read -rp "Email to reset: " email
[ -n "$email" ] || { echo "No email given."; exit 1; }
read -rsp "New password (8+ characters, hidden): " p1; echo
read -rsp "Type it again: " p2; echo
[ "$p1" = "$p2" ] || { echo "Passwords don't match. Nothing changed."; exit 1; }

printf '%s' "$p1" | docker compose exec -T paperclip node "$IN" "$email"
unset p1 p2
