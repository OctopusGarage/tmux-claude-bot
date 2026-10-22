#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.octopusgarage.tmux-claude-bot.plist"
LABEL="com.octopusgarage.tmux-claude-bot"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

WRAPPER="launchd-wrapper.sh"
LAUNCHER_ARGS=()
if [ "${1:-}" = "--dev" ]; then
  WRAPPER="dev-launchd-wrapper.sh"
  LAUNCHER_ARGS=("--dev")
  echo "[install-launchd] DEV mode: service will hot-reload from $PROJECT_DIR"
fi

"$SCRIPT_DIR/install-cli-launchers.sh" "${LAUNCHER_ARGS[@]}"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$PROJECT_DIR/logs"

sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__WRAPPER__|$WRAPPER|g" \
  "$SCRIPT_DIR/tmux-claude-bot.plist" > "$TARGET"

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
