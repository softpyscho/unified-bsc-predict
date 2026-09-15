#!/usr/bin/env bash
# Pulls the latest code from GitHub, rebuilds and restarts the worker, then prints its health.
set -euo pipefail
cd "${APP_DIR:-$HOME/unified-bsc-predict}"
git pull --ff-only
npm ci
npm run build
sudo systemctl restart bsc-predict
for _ in $(seq 1 30); do
  if curl -fs http://127.0.0.1:8080/api/health >/dev/null; then break; fi
  sleep 2
done
curl -s http://127.0.0.1:8080/api/health
echo
