#!/usr/bin/env bash
# Suburban Cyber Agent OS - one-line bootstrap.
#   curl -fsSL https://raw.githubusercontent.com/ajr1303/sct-agent-os/main/get.sh | sudo bash
set -euo pipefail
AOS_REPO="${AOS_REPO:-https://github.com/ajr1303/sct-agent-os.git}"
AOS_REF="${AOS_REF:-main}"
AOS_DIR="${AOS_DIR:-/opt/sct-agent-os}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: curl -fsSL <url> | sudo bash"; exit 1; }
[ "$(uname -s)" = "Linux" ] || { echo "Linux only."; exit 1; }

export DEBIAN_FRONTEND=noninteractive
need_pkg() { command -v "$1" >/dev/null 2>&1; }
# git+curl drive this bootstrap; openssl generates every secret in install.sh
# (preflight aborts without it); a cron daemon runs the watchdog/backup/update jobs.
if ! need_pkg git || ! need_pkg curl || ! need_pkg openssl || ! need_pkg crontab; then
  echo "==> Installing prerequisites (git, curl, openssl, cron)"
  if   need_pkg apt-get; then apt-get update -qq && apt-get install -y -qq git curl ca-certificates openssl cron
  elif need_pkg dnf;     then dnf install -y -q git curl openssl cronie
  elif need_pkg yum;     then yum install -y -q git curl openssl cronie
  else echo "Install git, curl, openssl, and cron, then re-run."; exit 1; fi
fi
# Make sure the cron daemon is actually running (Debian: cron, RHEL: crond).
systemctl enable --now cron >/dev/null 2>&1 || systemctl enable --now crond >/dev/null 2>&1 || true
if ! need_pkg docker; then
  echo "==> Installing Docker (official convenience script)"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

if [ -d "$AOS_DIR/.git" ]; then
  echo "==> Updating $AOS_DIR"
  git -C "$AOS_DIR" fetch --quiet origin "$AOS_REF"
  git -C "$AOS_DIR" checkout --quiet "$AOS_REF"
  git -C "$AOS_DIR" pull --quiet --ff-only origin "$AOS_REF"
else
  echo "==> Cloning to $AOS_DIR"
  git clone --quiet --branch "$AOS_REF" "$AOS_REPO" "$AOS_DIR"
fi
cd "$AOS_DIR"
# stdin is the curl pipe; give install.sh the real terminal for prompts
exec ./install.sh "$@" </dev/tty
