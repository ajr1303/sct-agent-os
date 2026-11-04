#!/usr/bin/env bash
# Nightly Honcho database dump; keeps 14 days
cd "$(dirname "$0")/.." || exit 1
docker ps --format '{{.Names}}' | grep -q '^agent-os-honcho-db$' || exit 0
mkdir -p backups
docker exec agent-os-honcho-db pg_dump -U honcho honcho | gzip > "backups/honcho-$(date +%F).sql.gz"
find backups -name 'honcho-*.sql.gz' -mtime +14 -delete
