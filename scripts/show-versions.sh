#!/usr/bin/env bash
# Print the exact upstream images this box is running, as .env pin lines.
# Run on a box you have TESTED; the output is what a release should pin so every
# later install gets the same builds instead of whatever "latest" is that day.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

pin() {  # pin <compose service> <ENV NAME>
  local cid img digest
  cid=$(docker compose ps -q "$1" 2>/dev/null | head -n1)
  [ -n "$cid" ] || { echo "# $1: not running"; return; }
  img=$(docker inspect -f '{{.Image}}' "$cid")
  digest=$(docker image inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$img" | grep -v '^$' | head -n1)
  if [ -n "$digest" ]; then echo "$2=$digest"; else echo "# $1: no registry digest (locally built image)"; fi
}

echo "# Agent OS $(cat VERSION 2>/dev/null) - upstream images on $(hostname), $(date -u +%F)"
pin hermes HERMES_IMAGE
pin n8n N8N_IMAGE
echo "# versions:"
docker compose exec -T n8n n8n --version 2>/dev/null | sed 's/^/#   n8n /' || true
docker compose exec -T hermes hermes --version 2>/dev/null | head -n1 | sed 's/^/#   /' || true
