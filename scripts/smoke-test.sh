#!/usr/bin/env bash
# Verifies the stack answers. Exit 0 = healthy.
cd "$(dirname "$0")/.." || exit 1
fail=0
ok()  { echo "  [ok]   $1"; }
bad() { echo "  [FAIL] $1"; fail=1; }
for i in $(seq 1 30); do
  curl -fsS http://127.0.0.1:9119/api/health 2>/dev/null | grep -q '"ok"' && break
  sleep 2
done
curl -fsS http://127.0.0.1:9119/api/health 2>/dev/null | grep -q '"ok"' && ok "dashboard /api/health (9119)" || bad "dashboard /api/health (9119)"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/ 2>/dev/null || true)
[ "$code" != "000" ] && ok "API server port 8642 answers (HTTP $code)" || bad "API server port 8642 not answering"
if docker ps --format '{{.Names}}' | grep -q honcho-api; then
  docker exec agent-os-honcho-api python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')" 2>/dev/null \
    && ok "Honcho API health" || bad "Honcho API health"
fi
ls data/hermes/dashboard-themes/suburban-cyber.yaml >/dev/null 2>&1 && ok "theme installed" || bad "theme missing"
exit $fail
