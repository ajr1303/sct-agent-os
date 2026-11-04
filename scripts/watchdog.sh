#!/usr/bin/env bash
# Restart stopped/unhealthy Agent OS containers; write data/health.json
cd "$(dirname "$0")/.." || exit 1
bad=0
for c in $(docker ps -a --filter "label=com.docker.compose.project=agent-os" --format '{{.Names}}'); do
  st=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")
  case "$st" in running/healthy|running/none|running/starting) ;; *) docker restart "$c" >/dev/null 2>&1; bad=$((bad+1));; esac
done
mkdir -p data
printf '{"checked":"%s","restarted":%d}\n' "$(date -u +%FT%TZ)" "$bad" > data/health.json
