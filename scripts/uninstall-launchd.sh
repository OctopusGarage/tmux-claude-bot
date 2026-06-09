#!/bin/bash
# Unload and remove the tmux-claude-bot launchd agent. Idempotent.
set -euo pipefail

PLIST_NAME="com.octopusgarage.tmux-claude-bot.plist"
LABEL="com.octopusgarage.tmux-claude-bot"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ -f "$TARGET" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$TARGET" 2>/dev/null || true
  rm -f "$TARGET"
  echo "[uninstall-launchd] Removed $TARGET"
else
  echo "[uninstall-launchd] No agent installed at $TARGET"
fi
