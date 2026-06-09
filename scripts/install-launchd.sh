#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.octopusgarage.tmux-claude-bot.plist"
LABEL="com.octopusgarage.tmux-claude-bot"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/logs"

sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$SCRIPT_DIR/tmux-claude-bot.plist" > "$TARGET"

echo "[install-launchd] Installed to $TARGET"

if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "[install-launchd] Unloading old service..."
  launchctl unload "$TARGET" 2>/dev/null || true
fi

echo "[install-launchd] Loading service..."
launchctl load "$TARGET"

echo "[install-launchd] Starting service..."
launchctl start "$LABEL" 2>/dev/null || true

echo "[install-launchd] Done. Check status with:"
echo "  launchctl list $LABEL"
echo "  tail -f $PROJECT_DIR/logs/launchd.err.log"
