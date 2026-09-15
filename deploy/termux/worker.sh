#!/usr/bin/env bash
# Keeps the server + worker running in Termux: holds a wake lock so Android does not put the CPU to sleep, restarts
# the server 10 s after any exit, and records each restart in logs/worker-supervisor.log. Only one copy runs at a
# time. Start it in the background:  nohup bash deploy/termux/worker.sh >/dev/null 2>&1 &
# Stop it with deploy/termux/stop.sh.
set -u
APP_DIR="${APP_DIR:-$HOME/unified-bsc-predict}"
cd "$APP_DIR"
mkdir -p logs data
PIDFILE="$APP_DIR/data/worker-supervisor.pid"
LOG="$APP_DIR/logs/worker-supervisor.log"

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "the worker is already running (supervisor pid $(cat "$PIDFILE"))"
  exit 0
fi
echo $$ >"$PIDFILE"
termux-wake-lock 2>/dev/null || true

child=""
shutdown() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  rm -f "$PIDFILE"
  termux-wake-unlock 2>/dev/null || true
  echo "$(date -Is) supervisor stopped" >>"$LOG"
  exit 0
}
trap shutdown INT TERM HUP

while true; do
  echo "$(date -Is) starting server" >>"$LOG"
  # Application logs go to logs/*.log; stdout is dropped, crash output is kept.
  node --disable-warning=ExperimentalWarning apps/server/dist/main.js >/dev/null 2>>logs/server-stderr.log &
  child=$!
  wait "$child"
  code=$?
  child=""
  echo "$(date -Is) server exited with code $code; restarting in 10 s" >>"$LOG"
  sleep 10
done
