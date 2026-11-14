#!/usr/bin/env bash
# Enable the Suburban Cyber dashboard plugins on the default Hermes profile.
#
# Hermes scopes enabled plugins per profile. Our dashboard plugins live in the
# DEFAULT profile (the cockpit the owner actually uses). The per-agent runtime
# profiles we create (one per Paperclip agent) don't carry these plugin files, so
# `hermes -p <agent> plugins enable <ours>` just errors with "No plugin named …" —
# there's nothing to enable there, and nobody browses the dashboard as an agent
# profile. So we enable on the default profile only.
#
# We wait for Hermes to be ready first, because `docker compose up -d` returns
# before the gateway is up and an early enable silently no-ops. Idempotent; used
# by install.sh and update.sh.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

AOS_PLUGINS="suburban-cyber suburban-chat suburban-mail suburban-bookings suburban-automations suburban-orchestration suburban-tasks suburban-agents suburban-usage"
warn() { echo "  ! $*" >&2; }

wait_for_hermes() {
  for _ in $(seq 1 60); do
    docker compose exec -T hermes hermes --version >/dev/null 2>&1 && return 0
    sleep 2
  done
  warn "Hermes did not report ready within ~2 min; attempting enable anyway."
  return 0
}

wait_for_hermes
for plug in $AOS_PLUGINS; do
  docker compose exec -T hermes hermes plugins enable "$plug" || warn "could not enable $plug"
done
echo "Plugins enabled."
