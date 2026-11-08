#!/usr/bin/env bash
# Enable the Suburban Cyber dashboard plugins on every Hermes profile.
#
# Hermes scopes enabled plugins per profile (plugin state follows the active
# profile), so a profile that lacks our plugins serves a blank dashboard. This
# script enables them on the default/active profile and on any additional
# profiles (the `hermes -p <name>` global flag selects the profile). It waits
# for Hermes to come up first, because `docker compose up -d` returns before the
# gateway is ready and an early enable silently no-ops.
#
# Safe to run repeatedly (enable is idempotent). Used by install.sh and update.sh.
set -uo pipefail
cd "$(dirname "$0")/.."

AOS_PLUGINS="suburban-cyber suburban-chat suburban-mail suburban-bookings suburban-automations suburban-orchestration suburban-tasks"
warn() { echo "  ! $*" >&2; }

wait_for_hermes() {
  local i
  for i in $(seq 1 60); do
    docker compose exec -T hermes hermes --version >/dev/null 2>&1 && return 0
    sleep 2
  done
  warn "Hermes did not report ready within ~2 min; attempting enable anyway."
  return 0
}

enable_for() {   # $1 = profile name ("" = default/active)
  local prof="$1" pflag="" plug
  [ -n "$prof" ] && pflag="-p $prof"
  for plug in $AOS_PLUGINS; do
    docker compose exec -T hermes hermes $pflag plugins enable "$plug" \
      || warn "could not enable $plug${prof:+ on profile $prof}"
  done
}

# Best-effort list of profiles beyond default. Each candidate is validated with
# `hermes -p <name> status` before use, so an unexpected `gateway list` format
# can never make us act on a bogus name — we just fall back to default only.
list_extra_profiles() {
  docker compose exec -T hermes hermes gateway list 2>/dev/null \
    | tr -s ' \t,' '\n' \
    | grep -viE '^(profile|gateway|name|status|running|stopped|state|-+|default)$' \
    | grep -E '^[A-Za-z0-9._-]+$' | sort -u || true
}

wait_for_hermes
enable_for ""
for prof in $(list_extra_profiles); do
  if docker compose exec -T hermes hermes -p "$prof" status >/dev/null 2>&1; then
    enable_for "$prof"
  fi
done
echo "Plugins enabled."
