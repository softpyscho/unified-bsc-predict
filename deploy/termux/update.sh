#!/usr/bin/env bash
# Pulls the latest code from GitHub, rebuilds, restarts the Termux worker and prints its health.
set -euo pipefail
APP_DIR="${APP_DIR:-$HOME/unified-bsc-predict}"
cd "$APP_DIR"
git pull --ff-only
npm ci
npm run build -w @bsc/server
npm run build -w @bsc/web || echo "operator console not rebuilt (optional on the phone)"
bash deploy/termux/stop.sh
nohup bash deploy/termux/worker.sh >/dev/null 2>&1 &
for _ in $(seq 1 30); do
  if curl -fs http://127.0.0.1:8080/api/health >/dev/null; then break; fi
  sleep 2
done
curl -s http://127.0.0.1:8080/api/health
echo
