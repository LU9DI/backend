#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$EUID" -eq 0 ]] || { echo 'Run as root'; exit 1; }
TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
[[ -n "$TOKEN" ]] || { echo "CLOUDFLARE_TUNNEL_TOKEN is required"; exit 1; }
apt-get update
apt-get install -y curl
ARCH=$(dpkg --print-architecture)
case "$ARCH" in amd64) PKG_ARCH="amd64";; arm64) PKG_ARCH="arm64";; *) echo "Unsupported architecture: $ARCH"; exit 1;; esac
curl -L --fail --silent --show-error -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${PKG_ARCH}.deb"
dpkg -i /tmp/cloudflared.deb
rm -f /tmp/cloudflared.deb
mkdir -p /etc/cloudflared
printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN" > /etc/cloudflared/tunnel-token
chmod 600 /etc/cloudflared/tunnel-token
cat >/etc/systemd/system/cloudflared-filtra.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel — Filtra.IA Oracle backup
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=5
EnvironmentFile=/etc/cloudflared/tunnel-token
ExecStart=/bin/sh -c 'exec /usr/bin/cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cloudflared-filtra.service
systemctl --no-pager --full status cloudflared-filtra.service || true
