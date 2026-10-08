#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR=/opt/filtra-ai
[[ "$EUID" -eq 0 ]] || { echo "Run as root: sudo bash bootstrap.sh"; exit 1; }
apt-get update
apt-get install -y ca-certificates curl git jq
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker
mkdir -p "$APP_DIR"
chmod 750 "$APP_DIR"
if [[ ! -f "$APP_DIR/.env" ]]; then touch "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"; fi
echo "Bootstrap complete: populate $APP_DIR/.env and copy docker-compose.yml/deploy.sh before first deploy."
