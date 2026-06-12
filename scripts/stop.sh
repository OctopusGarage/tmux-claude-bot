#!/bin/bash
# Stop tmux-claude-bot process safely

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="tmux-claude-bot"

echo "[stop] Searching for running instances of $PROJECT_NAME..."

# Try PID file first
PID=""
if [ -f "$PROJECT_ROOT/.bot.pid" ]; then
  CACHED_PID=$(cat "$PROJECT_ROOT/.bot.pid" 2>/dev/null)
  if [ -n "$CACHED_PID" ] && ps -p "$CACHED_PID" > /dev/null 2>&1; then
    PID="$CACHED_PID"
  fi
fi

# Fallback: search by pattern
if [ -z "$PID" ]; then
  PID=$(ps aux | grep -E "$PROJECT_NAME.*(src/index.ts|dist/cli.js)" | grep -v grep | awk '{print $2}' | head -1)
fi

if [ -z "$PID" ]; then
  echo "[stop] No running instance found."
  exit 0
fi

echo "[stop] Found PID: $PID"
kill -9 "$PID" 2>/dev/null

sleep 1

if ps -p "$PID" > /dev/null 2>&1; then
  echo "[stop] Failed to kill process $PID"
  exit 1
else
  echo "[stop] Process $PID stopped successfully."
  rm -f "$PROJECT_ROOT/.bot.pid"
fi