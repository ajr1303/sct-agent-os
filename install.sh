#!/usr/bin/env bash
# Suburban Cyber Agent OS installer (Hermes + optional Honcho memory)
set -euo pipefail
cd "$(dirname "$0")"

MEMORY_MODE=auto; ASSUME_YES=0; PROFILES_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --memory) MEMORY_MODE="$2"; shift 2;;
    --profiles) PROFILES_OVERRIDE="$2"; shift 2;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) echo "Usage: ./install.sh [--memory auto|honcho|basic] [--profiles \"automation,control-plane\"] [--yes]"; echo "  Profiles: memory (Honcho), automation (n8n), control-plane (Paperclip). Empty = lean."; exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

# Agent OS installs the FULL stack (Hermes + Honcho memory + n8n + Paperclip).
# One spec, sized for the whole thing with headroom to grow — 16 GB / 4 vCPU / 60 GB.
FULL_RAM_KB=15000000; REC_RAM_KB=16000000; MIN_DISK_GB=60; REC_DISK_GB=80
SUBSET_RAM_KB=3500000   # floor when an advanced operator passes --profiles
TTY=/dev/tty; [ -r "$TTY" ] || TTY=/dev/stdin
say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[31mx  %s\033[0m\n' "$*"; exit 1; }
gen_secret() { openssl rand -hex 32; }
ask() { # ask VAR "Prompt" "default"
  local v; printf '%s [%s]: ' "$2" "$3" >"$TTY"; read -r v <"$TTY" || true; printf -v "$1" '%s' "${v:-$3}"; }
ask_secret() { local v; printf '%s: ' "$2" >"$TTY"; read -rs v <"$TTY" || true; echo >"$TTY"; printf -v "$1" '%s' "$v"; }
confirm() { [ "$ASSUME_YES" = 1 ] && return 0; local v; printf '%s [y/N]: ' "$1" >"$TTY"; read -r v <"$TTY" || true; [[ "$v" =~ ^[Yy] ]]; }

preflight() {
  say "Checking this machine"
  [ "$(uname -s)" = Linux ] || die "Linux required."
  command -v docker >/dev/null || die "Docker not found. Use get.sh, or install Docker first."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin missing."
  docker info >/dev/null 2>&1 || die "Docker daemon not reachable (run as root or add your user to the docker group)."
  command -v openssl >/dev/null || die "openssl not found."
  local ram disk; ram=$(awk '/MemTotal/{print $2}' /proc/meminfo); disk=$(df -BG --output=avail . | tail -1 | tr -dc 0-9)
  if [ -n "$PROFILES_OVERRIDE" ]; then
    # Advanced: operator chose a specific subset, so only enforce a basic floor.
    [ "$ram" -ge "$SUBSET_RAM_KB" ] || die "Need at least 4 GB RAM (found $((ram/1024)) MB)."
  else
    [ "$ram" -ge "$FULL_RAM_KB" ] || die "Agent OS needs 16 GB RAM for the full stack (found ~$((ram/1024/1024)) GB). Use a larger server, or re-run with --profiles for a subset (advanced)."
  fi
  [ "$disk" -ge "$MIN_DISK_GB" ] || die "Need at least ${MIN_DISK_GB} GB free disk (found ${disk} GB)."
  [ "$disk" -ge "$REC_DISK_GB" ] || warn "Under ${REC_DISK_GB} GB free disk — tight for image builds + growth."
  for p in 8642 9119 5678 3100; do
    (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && die "Port $p already in use." || true
  done
  curl -fsS -o /dev/null --max-time 8 https://github.com || die "Cannot reach github.com."
  [ "$MEMORY_MODE" = auto ] && MEMORY_MODE=honcho
  echo "Memory mode: $MEMORY_MODE"
}

collect_answers() {
  say "A few questions"
  ask OWNER_NAME "Your name" "owner"
  ask AGENT_NAME "Name your agent" "navi"
  ask WORKSPACE  "Workspace name" "$(echo "$AGENT_NAME" | tr 'A-Z ' 'a-z-')-workspace"
  echo "Dashboard access: 1) this machine / SSH tunnel only  2) anyone on my network (LAN)"
  ask ACCESS "Choice" "1"
  if [ "$ACCESS" = 2 ]; then DASHBOARD_BIND=0.0.0.0; else DASHBOARD_BIND=127.0.0.1; fi
  if [ "$MEMORY_MODE" = honcho ]; then
    echo "LLM provider for the memory service:"
    echo "  1) OpenAI   2) Other OpenAI-compatible (OpenRouter, vLLM, etc.)"
    ask PROVIDER "Choice" "1"
    if [ "$PROVIDER" = 2 ]; then
      ask LLM_BASE_URL "Base URL" "https://openrouter.ai/api/v1"
      ask LLM_MODEL    "Chat model" "openai/gpt-4o-mini"
      ask EMBED_MODEL  "Embedding model" "openai/text-embedding-3-small"
    else
      LLM_BASE_URL=""; LLM_MODEL="gpt-4o-mini"; EMBED_MODEL="text-embedding-3-small"
    fi
    ask_secret LLM_API_KEY "API key (input hidden)"
    [ -n "$LLM_API_KEY" ] || die "API key required for Honcho memory (or re-run with --memory basic)."
    echo "Memory cost preset: 1) economy  2) balanced  3) deep"
    ask MEMORY_PRESET "Choice" "2"
    case "$MEMORY_PRESET" in
      1) DIALECTIC_CADENCE=5; DIALECTIC_LEVEL=low;;
      3) DIALECTIC_CADENCE=1; DIALECTIC_LEVEL=medium;;
      *) DIALECTIC_CADENCE=2; DIALECTIC_LEVEL=low;;
    esac
  fi
}

write_env() {
  say "Writing configuration"
  umask 077
  # Never regenerate secrets over an existing install (CODE_REVIEW F-10).
  # Rewriting .env would change HONCHO_DB_PASSWORD / N8N_ENCRYPTION_KEY /
  # CONNECTORS_KEY out from under already-initialised volumes: Postgres auth
  # breaks, n8n can't decrypt its credentials, and every Fernet-encrypted
  # connector secret becomes unreadable. Keep the existing .env, back it up, and
  # just refresh branding/dirs. get.sh routes real re-runs to update.sh anyway.
  if [ -f .env ]; then
    cp -p .env ".env.bak.$(date +%Y%m%d%H%M%S)"
    say "Existing install detected — keeping your secrets in .env (backup written)."
    mkdir -p data/hermes/dashboard-themes backups
    if [ "$MEMORY_MODE" = honcho ]; then
      [ -f honcho.env ] || write_honcho_env
      [ -f data/hermes/honcho.json ] || write_honcho_json
    fi
    ./scripts/sync-branding.sh
    return
  fi
  # Detect the address users reach this box at. The full stack is the default;
  # --profiles is an advanced subset override (preflight relaxes RAM for it).
  local lan_ip pc_host profs
  lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}'); [ -n "$lan_ip" ] || lan_ip="127.0.0.1"
  if [ "$DASHBOARD_BIND" != "127.0.0.1" ]; then pc_host="$lan_ip"; else pc_host="localhost"; fi
  if [ -n "$PROFILES_OVERRIDE" ]; then
    profs="$PROFILES_OVERRIDE"
  elif [ "$MEMORY_MODE" = honcho ]; then
    profs="memory,automation,control-plane"
  else
    # basic memory: no Honcho containers, so don't start the "memory" profile —
    # honcho.env isn't written and the Honcho services would fail without it.
    profs="automation,control-plane"
  fi
  case ",$profs," in *,control-plane,*) say "Building the full stack — Paperclip compiles from source on first start (several minutes)." ;; esac
  cat > .env <<ENV
API_SERVER_KEY=$(gen_secret)
DASHBOARD_USER=admin
DASHBOARD_BIND=$DASHBOARD_BIND
DASHBOARD_PASSWORD=$(openssl rand -base64 18 | tr -dc A-Za-z0-9 | cut -c1-20)
HONCHO_DB_PASSWORD=$(gen_secret)
CONNECTORS_KEY=$(openssl rand -base64 32 | tr '+/' '-_')
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)
HERMES_TAG=latest
HERMES_HOME_DIR=./data/hermes
HERMES_MEM_LIMIT=3G
PAPERCLIP_PUBLIC_URL=http://${pc_host}:3100
PAPERCLIP_ALLOWED_HOSTNAMES=paperclip,localhost,127.0.0.1,${lan_ip}
COMPOSE_PROFILES=${profs}
ENV
  mkdir -p data/hermes/dashboard-themes backups
  if [ "$MEMORY_MODE" = honcho ]; then write_honcho_env; write_honcho_json; fi
  ./scripts/sync-branding.sh
}

emit_model_block() { # emit_model_block PREFIX MODEL
  local p="$1" m="$2"
  echo "${p}__TRANSPORT=openai"; echo "${p}__MODEL=${m}"
  if [ -n "$LLM_BASE_URL" ]; then
    echo "${p}__OVERRIDES__BASE_URL=${LLM_BASE_URL}"
    echo "${p}__STRUCTURED_OUTPUT_MODE=json_object"
  fi
}

write_honcho_env() {
  local pw; pw=$(grep ^HONCHO_DB_PASSWORD= .env | cut -d= -f2)
  {
    echo "LOG_LEVEL=INFO"
    echo "AUTH_USE_AUTH=false"
    echo "DB_CONNECTION_URI=postgresql+psycopg://honcho:${pw}@honcho-db:5432/honcho"
    echo "LLM_OPENAI_API_KEY=${LLM_API_KEY}"
    emit_model_block DERIVER_MODEL_CONFIG "$LLM_MODEL"
    emit_model_block SUMMARY_MODEL_CONFIG "$LLM_MODEL"
    emit_model_block DREAM_DEDUCTION_MODEL_CONFIG "$LLM_MODEL"
    emit_model_block DREAM_INDUCTION_MODEL_CONFIG "$LLM_MODEL"
    for lv in minimal low medium high max; do emit_model_block "DIALECTIC_LEVELS__${lv}__MODEL_CONFIG" "$LLM_MODEL"; done
    echo "EMBEDDING_MODEL_CONFIG__TRANSPORT=openai"
    echo "EMBEDDING_MODEL_CONFIG__MODEL=${EMBED_MODEL}"
    [ -n "$LLM_BASE_URL" ] && echo "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=${LLM_BASE_URL}"
  } > honcho.env
  chmod 600 honcho.env
}

write_honcho_json() {
  sed -e "s/__AI_PEER__/${AGENT_NAME}/g" -e "s/__USER_PEER__/${OWNER_NAME}/g" -e "s/__WORKSPACE__/${WORKSPACE}/g" \
      -e "s/__DIALECTIC_CADENCE__/${DIALECTIC_CADENCE}/g" -e "s/__DIALECTIC_LEVEL__/${DIALECTIC_LEVEL}/g" \
      templates/honcho.json.tmpl > data/hermes/honcho.json
}

hermes_first_run() {
  say "Hermes first-time setup (pick your model/provider and messaging)"
  docker compose run --rm -it hermes setup <"$TTY" || warn "hermes setup exited non-zero; re-run: docker compose run --rm -it hermes setup"
  docker compose run --rm hermes config set dashboard.theme suburban-cyber || warn "could not set default theme; pick it in the dashboard"
  if [ "$MEMORY_MODE" = honcho ]; then
    docker compose run --rm hermes plugins install honcho || warn "honcho plugin install failed"
  fi
}

start_stack() {
  say "Starting services (first run builds Honcho; a few minutes)"
  docker compose up -d --build
}

install_cron() {
  say "Installing watchdog, nightly backup, and update check"
  local here; here=$(pwd)
  if command -v crontab >/dev/null 2>&1; then
    { crontab -l 2>/dev/null | grep -v '# agent-os-managed' || true
      echo "*/5 * * * * $here/scripts/watchdog.sh # agent-os-managed"
      echo "30 3 * * * $here/scripts/backup.sh # agent-os-managed"
      echo "17 */6 * * * $here/scripts/check-updates.sh # agent-os-managed"; } | crontab - \
      && say "Scheduled watchdog (5m), backup (3:30am), update check (6h)"
  else
    warn "crontab not found - skipping watchdog/backup/update-check schedule."
    warn "Install cron (apt: cron / dnf: cronie), then re-run: $here/install.sh (or add the 3 jobs in scripts/ by hand)."
  fi
  ./scripts/check-updates.sh 2>/dev/null || true   # seed the status now
}

# Enable the Suburban Cyber dashboard plugins on every profile. Delegated to a
# shared script so install and update stay in lock-step. It waits for Hermes to
# be ready first (up -d returns before the gateway is), which also fixes the old
# race where the enable loop silently no-opped on first boot.
enable_plugins() { ./scripts/enable-plugins.sh || warn "plugin enable reported problems; check: docker compose logs hermes"; }

main() {
  preflight
  collect_answers
  write_env
  say "Generating internal gateway TLS (Paperclip -> Hermes hop)"
  ./scripts/gen-tls.sh || warn "gateway TLS generation failed - agents won't run until this is fixed"
  hermes_first_run
  start_stack
  enable_plugins
  install_cron
  say "Smoke test"
  ./scripts/smoke-test.sh || warn "Some checks failed - see above. Logs: docker compose logs"
  if [ "$MEMORY_MODE" = honcho ]; then docker compose exec -T hermes hermes memory status || true; fi
  if [ "$DASHBOARD_BIND" = 0.0.0.0 ]; then
    ip=$(hostname -I | awk '{print $1}')
    where="http://${ip}:9119   (LAN; plain HTTP, so keep it on a trusted network)"
  else
    where="http://localhost:9119 after: ssh -L 9119:127.0.0.1:9119 <user>@<this-server>"
  fi
  cat <<DONE

Agent OS is running.
Dashboard: $where
Login:     admin / $(grep ^DASHBOARD_PASSWORD= .env | cut -d= -f2)   (also in $(pwd)/.env)
Pick the "Suburban Cyber" theme in the dashboard. The agent API (8642) stays on localhost.
DONE
}
main
