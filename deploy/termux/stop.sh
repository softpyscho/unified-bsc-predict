#!/usr/bin/env bash
# Stops the Termux worker (supervisor and server) cleanly; the server releases its worker lease on the way out.
APP_DIR="${APP_DIR:-$HOME/unified-bsc-predict}"
PIDFILE="$APP_DIR/data/worker-supervisor.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  kill -TERM "$(cat "$PIDFILE")"
  for _ in $(seq 1 40); do
    kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || break
    sleep 1
  done
fi
# Anything left over (e.g. a server started by hand).
pkill -TERM -f 'apps/server/dist/main.js' 2>/dev/null || true
rm -f "$PIDFILE"
termux-wake-unlock 2>/dev/null || true
echo "stopped"
