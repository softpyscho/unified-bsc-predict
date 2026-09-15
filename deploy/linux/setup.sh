#!/usr/bin/env bash
# One-command setup of the BSC Predict worker on an Ubuntu VM (e.g. Oracle Cloud "Always Free").
# Installs Node.js 24 and git, clones (or updates) the repository, builds it, and installs a systemd service that
# starts at boot and restarts after any crash. Run it as the VM's normal user (it uses sudo where needed):
#
#   curl -fsSL https://raw.githubusercontent.com/softpyscho/unified-bsc-predict/main/deploy/linux/setup.sh | bash
#
# Safe to run again: it updates the code and rebuilds.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/softpyscho/unified-bsc-predict.git}"
APP_DIR="${APP_DIR:-$HOME/unified-bsc-predict}"
SERVICE=bsc-predict

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user (for example 'ubuntu'), not as root; it uses sudo where needed." >&2
  exit 1
fi

echo "==> system packages"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Node.js 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node $(node --version)"

# 1 GB machines need swap to build the dashboard.
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
if [ "$mem_kb" -lt 2000000 ] && [ -z "$(swapon --show)" ]; then
  echo "==> adding a 2 GB swap file"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> code in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci
npm run build

echo "==> systemd service '$SERVICE'"
sed -e "s#__USER__#$USER#g" -e "s#__DIR__#$APP_DIR#g" -e "s#__NODE__#$(command -v node)#g" \
  deploy/linux/bsc-predict.service | sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null

if [ -f "$APP_DIR/.env" ]; then
  chmod 600 "$APP_DIR/.env"
  sudo systemctl restart "$SERVICE"
  echo "==> started. Check it with:  curl -s http://127.0.0.1:8080/api/health"
else
  echo
  echo "Almost done: create $APP_DIR/.env (docs/DEPLOYMENT.md, step 1E), then run:"
  echo "  chmod 600 $APP_DIR/.env && sudo systemctl start $SERVICE"
fi
