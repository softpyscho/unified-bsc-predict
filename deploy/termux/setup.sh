#!/usr/bin/env bash
# One-command setup of the BSC Predict worker on an Android phone, inside the Termux app.
# Installs Node.js and git, clones (or updates) the repository, builds it, installs a Termux:Boot hook so the worker
# starts after every phone restart, and starts it if .env is already in place. Run inside Termux:
#
#   curl -fsSL https://raw.githubusercontent.com/softpyscho/unified-bsc-predict/main/deploy/termux/setup.sh | bash
#
# Safe to run again: it updates the code and rebuilds. Guide: docs/ANDROID.md
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/softpyscho/unified-bsc-predict.git}"
APP_DIR="${APP_DIR:-$HOME/unified-bsc-predict}"

if [ -z "${PREFIX:-}" ] || ! command -v pkg >/dev/null 2>&1; then
  echo "Run this inside the Termux app on Android." >&2
  exit 1
fi

echo "==> packages (this can take a few minutes the first time)"
pkg update -y
pkg upgrade -y -o Dpkg::Options::="--force-confnew"
pkg install -y nodejs-lts git curl procps
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "==> nodejs-lts is older than 22.13; installing the current Node.js instead"
  pkg install -y nodejs
fi
echo "node $(node --version)"

echo "==> code in $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci
npm run build -w @bsc/server
# The operator console is optional on the phone: the worker and its API run without it.
if npm run build -w @bsc/web; then
  echo "==> operator console built (open http://127.0.0.1:8080 in the phone's browser)"
else
  echo "==> operator console could not be built here; the worker and its API run without it"
fi

echo "==> start after every phone restart (needs the Termux:Boot app, opened once)"
mkdir -p "$HOME/.termux/boot"
cat >"$HOME/.termux/boot/bsc-predict.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$APP_DIR" && nohup bash deploy/termux/worker.sh >/dev/null 2>&1 &
EOF
chmod +x "$HOME/.termux/boot/bsc-predict.sh"

if [ -f "$APP_DIR/.env" ]; then
  chmod 600 "$APP_DIR/.env"
  bash deploy/termux/stop.sh >/dev/null 2>&1 || true
  nohup bash deploy/termux/worker.sh >/dev/null 2>&1 &
  echo "==> started. Check it in a minute with:  curl -s http://127.0.0.1:8080/api/health"
else
  echo
  echo "Almost done: copy your .env into $APP_DIR (docs/ANDROID.md, step 5), then run:"
  echo "  chmod 600 $APP_DIR/.env && nohup bash $APP_DIR/deploy/termux/worker.sh >/dev/null 2>&1 &"
fi
