#!/bin/bash
# Start tmux-claude-bot process

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROJECT_NAME="tmux-claude-bot"

# Stop any existing instance first
PID=$(ps aux | grep "$PROJECT_NAME.*src/index.ts" | grep -v grep | awk '{print $2}' | head -1)
if [ -n "$PID" ]; then
  echo "[start] Stopping existing instance (PID: $PID)..."
  kill -9 "$PID" 2>/dev/null
  sleep 1
fi

# Clean up stale PID file
rm -f "$PROJECT_ROOT/.bot.pid"

echo "[start] Starting $PROJECT_NAME..."
cd "$PROJECT_ROOT"

# Use npm run dev for development with auto-reload
npm run dev > logs/bot-start.log 2>&1 &
PID=$!
echo $PID > "$PROJECT_ROOT/.bot.pid"

echo "[start] Bot started in background (PID: $PID). See logs/bot-start.log for output."