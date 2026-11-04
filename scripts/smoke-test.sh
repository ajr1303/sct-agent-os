#!/usr/bin/env bash
# Verifies the stack answers. Exit 0 = healthy.
cd "$(dirname "$0")/.." || exit 1
fail=0
ok()  { echo "  [ok]   $1"; }
bad() { echo "  [FAIL] $1"; fail=1; }
# Dashboard needs HERMES_DASHBOARD=1 plus an auth provider; any HTTP answer (200 or a login redirect) means it is up.
dash=000
for _ in $(seq 1 45); do
  dash=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9119/ 2>/dev/null || true)
  [ "$dash" != "000" ] && break
  sleep 2
done
[ "$dash" != "000" ] && ok "dashboard answers on 9119 (HTTP $dash)" || bad "dashboard not answering on 9119 (docker compose logs hermes)"
gw=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8642/health 2>/dev/null || true)
[ "$gw" = "200" ] && ok "gateway API /health (8642)" || bad "gateway API /health (8642) returned $gw"
if docker ps --format '{{.Names}}' | grep -q honcho-api; then
  docker exec agent-os-honcho-api python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health')" 2>/dev/null \
    && ok "Honcho API health" || bad "Honcho API health"
fi
ls data/hermes/dashboard-themes/suburban-cyber.yaml >/dev/null 2>&1 && ok "theme installed" || bad "theme missing"
exit $fail
