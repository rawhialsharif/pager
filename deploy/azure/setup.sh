#!/usr/bin/env bash
# One-time setup of the digital pager on a fresh Ubuntu server
# (Azure, AWS Lightsail, Oracle Cloud, or any Ubuntu/Debian VPS).
#
#   sudo bash setup.sh order.yourdomain.com you@yourdomain.com
#
# Installs Node.js and cloudflared, puts the app in /opt/pager, runs it as a service,
# and turns on auto-deploy (checks GitHub every minute; tests new commits before using them).
# Safe to run again: it updates everything in place and keeps your data and settings.

set -euo pipefail

PUBLIC_HOST="${1:-}"
CONTACT_EMAIL="${2:-}"
REPO_URL="${REPO_URL:-https://github.com/rawhialsharif/pager.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/pager
DATA_ROOT=/var/lib/pager
CONF_DIR=/etc/pager
NODE_MAJOR=22

die() {
  echo "Error: $*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "run it with sudo: sudo bash $0 order.yourdomain.com you@yourdomain.com"
[[ -n "$PUBLIC_HOST" && -n "$CONTACT_EMAIL" ]] || die "usage: sudo bash $0 order.yourdomain.com you@yourdomain.com"
[[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
  die "'$PUBLIC_HOST' doesn't look like a web address. Use just the name, like order.yourdomain.com (no https://)"
[[ "$CONTACT_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "'$CONTACT_EMAIL' doesn't look like an email address"
command -v apt-get >/dev/null || die "this script supports Ubuntu or Debian only"
ARCH="$(dpkg --print-architecture)"
[[ "$ARCH" == amd64 || "$ARCH" == arm64 ]] || die "unsupported processor type: $ARCH"

add_apt_repo() { # name, key URL, repo URL, suite
  local name="$1" key_url="$2" repo_url="$3" suite="$4"
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL "$key_url" | gpg --dearmor --batch --yes -o "/usr/share/keyrings/$name.gpg"
  chmod 644 "/usr/share/keyrings/$name.gpg"
  printf '%s\n' 'Types: deb' "URIs: $repo_url" "Suites: $suite" 'Components: main' \
    "Architectures: $ARCH" "Signed-By: /usr/share/keyrings/$name.gpg" >"/etc/apt/sources.list.d/$name.sources"
}

step "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q git curl ca-certificates gnupg

step "Installing Node.js"
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if ((node_major < 20)); then
  # Ubuntu's own package is too old (Node 18), so use NodeSource's official repository.
  add_apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "https://deb.nodesource.com/node_${NODE_MAJOR}.x" nodistro
  apt-get update -q
  apt-get install -y -q nodejs
fi
NODE_BIN="$(command -v node)"
echo "Node $("$NODE_BIN" --version) at $NODE_BIN"

step "Installing cloudflared"
if ! command -v cloudflared >/dev/null; then
  add_apt_repo cloudflare-main https://pkg.cloudflare.com/cloudflare-main.gpg https://pkg.cloudflare.com/cloudflared any
  apt-get update -q
  apt-get install -y -q cloudflared
fi
CLOUDFLARED_BIN="$(command -v cloudflared)"
echo "$("$CLOUDFLARED_BIN" --version | head -1)"

step "Creating the pager user and folders"
id pager &>/dev/null || useradd --system --home-dir "$DATA_ROOT" --shell /usr/sbin/nologin pager
install -d -o pager -g pager -m 750 "$DATA_ROOT" "$DATA_ROOT/data"
install -d -m 755 "$CONF_DIR"

step "Getting the code from $REPO_URL"
if [[ -d "$APP_DIR/.git" ]]; then
  runuser -u pager -- git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  runuser -u pager -- git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  install -d -o pager -g pager "$APP_DIR"
  runuser -u pager -- git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
echo "At commit $(runuser -u pager -- git -C "$APP_DIR" log --oneline -1)"

step "Writing settings"
# Restaurants and staff PINs live here, outside the public repo.
new_branches_file=0
if [[ ! -f "$CONF_DIR/branches.json" ]]; then
  cp "$APP_DIR/digital-pager/config/branches.json" "$CONF_DIR/branches.json"
  new_branches_file=1
fi
chown root:pager "$CONF_DIR/branches.json"
chmod 640 "$CONF_DIR/branches.json"

cat >"$CONF_DIR/pager.env" <<EOF
# Settings for pager.service. Rewritten each time setup.sh runs.
# After editing by hand: sudo systemctl restart pager
PORT=3000
HOST=127.0.0.1
PUBLIC_URL=https://$PUBLIC_HOST
VAPID_SUBJECT=mailto:$CONTACT_EMAIL
TRUST_PROXY=1
TIME_ZONE=Asia/Amman
DATA_DIR=$DATA_ROOT/data
BRANCHES_FILE=$CONF_DIR/branches.json
EOF
chown root:pager "$CONF_DIR/pager.env"
chmod 640 "$CONF_DIR/pager.env"

step "Installing services"
units="$APP_DIR/deploy/azure/systemd"
sed "s|@NODE@|$NODE_BIN|" "$units/pager.service" >/etc/systemd/system/pager.service
sed "s|@CLOUDFLARED@|$CLOUDFLARED_BIN|" "$units/pager-tunnel.service" >/etc/systemd/system/pager-tunnel.service
install -m 644 "$units/pager-update.service" "$units/pager-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet pager.service pager-update.timer
systemctl restart pager.service
systemctl start pager-update.timer
if [[ -f /etc/cloudflared/config.yml ]]; then
  systemctl enable --quiet pager-tunnel.service
  systemctl restart pager-tunnel.service
fi

step "Checking the app"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.5
done
if ((ok == 0)); then
  journalctl -u pager -n 30 --no-pager || true
  die "the app didn't start. The log is above."
fi
echo "The app is running: $(curl -fsS http://127.0.0.1:3000/healthz)"

echo
echo "Done. Auto-deploy is on: new commits on '$BRANCH' go live within about a minute, after their tests pass."
if ((new_branches_file == 1)); then
  echo
  echo "IMPORTANT: change the staff PIN (it's the demo PIN 1234):"
  echo "  sudo nano $CONF_DIR/branches.json     then: sudo systemctl restart pager"
fi
if [[ ! -f /etc/cloudflared/config.yml ]]; then
  echo
  echo "Next, connect https://$PUBLIC_HOST to this server:"
  echo "  sudo bash $APP_DIR/deploy/azure/tunnel.sh $PUBLIC_HOST"
fi
