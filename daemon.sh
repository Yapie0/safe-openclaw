#!/usr/bin/env bash
set -euo pipefail

# safe-openclaw daemon — run gateway in background (survives SSH disconnect)

LOGFILE="/tmp/openclaw-gateway.log"
PIDFILE="/tmp/openclaw-gateway.pid"

# ── Source nvm ───────────────────────────────────────────────────────────────
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
usage() {
  echo "Usage: $0 {start|stop|restart|status|log}"
  exit 1
}

is_running() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid=$(cat "$PIDFILE")
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    # stale pidfile
    rm -f "$PIDFILE"
  fi
  return 1
}

do_start() {
  if is_running; then
    echo "Gateway is already running (PID $(cat "$PIDFILE"))."
    return 0
  fi

  if ! command -v openclaw &>/dev/null; then
    echo "ERROR: openclaw not found. Run install.sh first."
    exit 1
  fi

  echo "Starting gateway in background..."
  nohup openclaw gateway run > "$LOGFILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PIDFILE"
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    echo "Gateway started (PID $pid)."
    echo "  Log: $LOGFILE"
    echo "  URL: http://localhost:18789/"
  else
    echo "ERROR: Gateway failed to start. Check log:"
    echo "  tail -20 $LOGFILE"
    rm -f "$PIDFILE"
    exit 1
  fi
}

do_stop() {
  if ! is_running; then
    echo "Gateway is not running."
    return 0
  fi

  local pid
  pid=$(cat "$PIDFILE")
  echo "Stopping gateway (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  sleep 2

  if kill -0 "$pid" 2>/dev/null; then
    echo "  Forcing kill..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PIDFILE"
  echo "Gateway stopped."
}

do_status() {
  if is_running; then
    echo "Gateway is running (PID $(cat "$PIDFILE"))."
  else
    echo "Gateway is not running."
  fi
}

do_log() {
  if [ -f "$LOGFILE" ]; then
    tail -50 "$LOGFILE"
  else
    echo "No log file found at $LOGFILE"
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  log)     do_log ;;
  *)       usage ;;
esac
