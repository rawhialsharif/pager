#!/usr/bin/env bash
# Connects your domain to this server with a Cloudflare tunnel. Run after setup.sh.
#
#   sudo bash tunnel.sh order.yourdomain.com
#
# Creates a tunnel called "pager-server" (or reuses it), points the address at it
# (replacing an older record, such as one pointing at your laptop), and starts it as a service.

set -euo pipefail

PUBLIC_HOST="${1:-}"
TUNNEL_NAME="${TUNNEL_NAME:-pager-server}"
CF_DIR=/etc/cloudflared
CONFIG="$CF_DIR/config.yml"

die() {
  echo "Error: $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || die "run it with sudo: sudo bash $0 order.yourdomain.com"
[[ -n "$PUBLIC_HOST" ]] || die "usage: sudo bash $0 order.yourdomain.com"
command -v cloudflared >/dev/null || die "cloudflared isn't installed. Run setup.sh first."
[[ -f /etc/systemd/system/pager-tunnel.service ]] || die "run setup.sh first"

if [[ ! -f /root/.cloudflared/cert.pem ]]; then
  echo "Open the link below on your own computer, sign in to Cloudflare and click your domain."
  echo "This server will continue by itself once you've done that."
  echo
  cloudflared tunnel login
fi

tunnel_id=""
if [[ -f "$CONFIG" ]]; then
  tunnel_id="$(awk '/^tunnel:/ {print $2}' "$CONFIG")"
  [[ -f "$CF_DIR/$tunnel_id.json" ]] || tunnel_id=""
fi

if [[ -n "$tunnel_id" ]]; then
  echo "Reusing tunnel $tunnel_id"
else
  before="$(ls /root/.cloudflared/*.json 2>/dev/null || true)"
  if ! cloudflared tunnel create "$TUNNEL_NAME"; then
    die "couldn't create the tunnel. If a tunnel named '$TUNNEL_NAME' already exists from an earlier try, delete it with:
  cloudflared tunnel delete $TUNNEL_NAME
then run this script again."
  fi
  creds=""
  for f in /root/.cloudflared/*.json; do
    grep -qxF "$f" <<<"$before" || creds="$f"
  done
  [[ -n "$creds" ]] || die "couldn't find the new tunnel's credentials file in /root/.cloudflared"
  tunnel_id="$(basename "$creds" .json)"
  [[ "$tunnel_id" =~ ^[0-9a-f-]{36}$ ]] || die "unexpected credentials file name: $creds"

  install -d -m 755 "$CF_DIR"
  install -m 600 "$creds" "$CF_DIR/$tunnel_id.json"
  cat >"$CONFIG" <<EOF
# Cloudflare tunnel for the digital pager (written by tunnel.sh)
tunnel: $tunnel_id
credentials-file: $CF_DIR/$tunnel_id.json
url: http://127.0.0.1:3000
EOF
  chmod 644 "$CONFIG"
fi

echo "Pointing $PUBLIC_HOST at this server…"
cloudflared tunnel route dns --overwrite-dns "$tunnel_id" "$PUBLIC_HOST"

systemctl daemon-reload
systemctl enable --quiet pager-tunnel.service
systemctl restart pager-tunnel.service

echo "Waiting for https://$PUBLIC_HOST to answer (DNS can take a minute or two)…"
for _ in $(seq 1 60); do
  if curl -fsS "https://$PUBLIC_HOST/healthz" >/dev/null 2>&1; then
    echo "Live: https://$PUBLIC_HOST"
    echo "Print the QR code from https://$PUBLIC_HOST/qr/demo-cafe"
    exit 0
  fi
  sleep 3
done
echo "Not answering yet. The tunnel is running; DNS may still be updating. Check again in a few minutes:"
echo "  curl https://$PUBLIC_HOST/healthz"
echo "Tunnel log: journalctl -u pager-tunnel -n 50"
