#!/usr/bin/env bash
# Ask every agent's own Hermes gateway which model and provider it is configured to
# use, and store the answers for the dashboard's Agents page.
#
# The asking happens inside the Paperclip container, where each gateway's key already
# lives in Paperclip's encrypted secret store. The key is used in place for one
# read-only request and is never printed, copied out or stored anywhere else. Only
# model names reach the dashboard. Safe to run any time; update.sh schedules it.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

docker compose ps --status running --services 2>/dev/null | grep -qx paperclip || { echo "Paperclip is not running; skipped."; exit 0; }
docker compose cp scripts/lib/agent-models.mjs paperclip:/tmp/agent-models.mjs >/dev/null || exit 1
docker compose exec -T paperclip node /tmp/agent-models.mjs \
  | docker compose exec -T connectors python store_agent_models.py
