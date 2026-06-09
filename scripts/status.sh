#!/bin/bash
# Check and optionally stop tmux-claude-bot process

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="tmux-claude-bot"
PID_FILE="$PROJECT_ROOT/.bot.pid"

# Check if a PID file exists and if the process is still running
check_pid() {
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$PID" ] && ps -p "$PID" > /dev/null 2>&1; then
      echo "$PID"
      return 0
    fi
  fi

  # Fallback: search by pattern
  PID=$(ps aux | grep "$PROJECT_NAME.*src/index.ts" | grep -v grep | awk '{print $2}' | head -1)
  if [ -n "$PID" ]; then
    echo "$PID"
    return 0
  fi
  return 1
}

if ! check_pid; then
  echo "[status] No running instance found."
  exit 1
fi

echo "[status] Running instance found."
echo "[status] PID: $PID"
echo "[status] Uptime:"
ps -p "$PID" -o etime= 2>/dev/null