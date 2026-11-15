#!/usr/bin/env bash
# Turn two-step sign-in off from the server. Use this when the phone with the
# authenticator app is lost and no recovery codes are left. The dashboard password is
# not changed. Set two-step sign-in up again from the dashboard's Security page.
set -u
cd "$(dirname "$0")/.." || exit 1
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
docker ps --format '{{.Names}}' | grep -qx agent-os-connectors || { echo "The connectors service is not running."; exit 1; }
docker exec agent-os-connectors python -c "
import app
app._mfa_save({'enabled': False})
print('Two-step sign-in is off.')" || { echo "Could not switch it off."; exit 1; }
./scripts/host-requests.sh
echo "The dashboard now asks for the password only. Turn two-step sign-in back on under Security."
