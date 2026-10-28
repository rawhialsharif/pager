#!/usr/bin/env bash
# Add, rename or remove restaurants (and change staff PINs) safely.
#
#   sudo bash /opt/pager/deploy/azure/restaurants.sh          edit, check, apply
#   sudo bash /opt/pager/deploy/azure/restaurants.sh --list   show restaurants and their links
#
# Opens a copy of the restaurants file in an editor. Your changes are checked first; the
# live file is replaced and the app restarted only if they're valid. If the app doesn't
# come back, the previous file is restored automatically.

set -euo pipefail

CONF="${PAGER_BRANCHES:-/etc/pager/branches.json}"
ENV_FILE="${PAGER_ENV:-/etc/pager/pager.env}"
APP="${PAGER_APP:-/opt/pager/digital-pager}"
GROUP="${PAGER_GROUP:-pager}"
HEALTH_URL="${PAGER_HEALTH_URL:-http://127.0.0.1:3000/healthz}"
RESTART_CMD="${PAGER_RESTART_CMD:-systemctl restart pager}"
EDITOR_CMD="${EDITOR:-nano}"

die() {
  echo "Error: $*" >&2
  exit 1
}

[[ $EUID -eq 0 || -n "${PAGER_ALLOW_NON_ROOT:-}" ]] || die "run it with sudo: sudo bash $0"
[[ -f "$CONF" ]] || die "$CONF doesn't exist. Run setup.sh first."

check() { node "$APP/src/branches.js" "$1"; }

print_links() {
  local base=""
  [[ -f "$ENV_FILE" ]] && base="$(sed -n 's/^PUBLIC_URL=//p' "$ENV_FILE" | tail -1)"
  base="${base:-https://your-domain}"
  echo
  echo "Restaurants:"
  check "$CONF" | while IFS=$'\t' read -r slug rest; do
    echo "  $rest"
    echo "    customers (QR code opens): $base/r/$slug"
    echo "    staff dashboard:           $base/staff/$slug"
    echo "    printable QR code:         $base/qr/$slug"
  done
}

if [[ "${1:-}" == "--list" ]]; then
  print_links
  exit 0
fi

tmp="$(mktemp --suffix=.json)"
trap 'rm -f "$tmp"' EXIT
cp "$CONF" "$tmp"

while true; do
  $EDITOR_CMD "$tmp"
  if result="$(check "$tmp" 2>&1)"; then
    break
  fi
  echo
  echo "That change can't be used yet:"
  echo "  ${result//$tmp/Your edit}"
  read -r -p "Open it again to fix? [Y/n] " answer
  if [[ "$answer" =~ ^[Nn] ]]; then
    echo "Nothing was changed. The restaurants are as they were."
    exit 1
  fi
done

if cmp -s "$tmp" "$CONF"; then
  echo "No changes."
  exit 0
fi

echo "$result" | grep -q "demo PIN" && echo "Note: a restaurant still uses the demo PIN 1234."

backup="$CONF.previous"
cp -p "$CONF" "$backup"
install -m 640 -o root -g "$GROUP" "$tmp" "$CONF"
eval "$RESTART_CMD"

for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Saved and applied."
    print_links
    exit 0
  fi
  sleep 0.5
done

echo "The app didn't come back after the change. Restoring the previous restaurants file…" >&2
cp -p "$backup" "$CONF"
eval "$RESTART_CMD"
die "restored the previous version. Check the log: journalctl -u pager -n 30"
