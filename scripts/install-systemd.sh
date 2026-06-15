#!/bin/bash
# Install + start the tmux-claude-bot systemd --user service (Linux). Idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
UNIT="tmux-claude-bot"
UNIT_DIR="$HOME/.config/systemd/user"
TARGET="$UNIT_DIR/$UNIT.service"

mkdir -p "$UNIT_DIR"
mkdir -p "$PROJECT_DIR/logs"

sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$SCRIPT_DIR/$UNIT.service" > "$TARGET"
echo "[install-systemd] Installed unit to $TARGET"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"

# Run the service even when no user session is logged in (headless servers).
if ! loginctl enable-linger "$USER" 2>/dev/null; then
  echo "[install-systemd] warning: could not enable linger; service may stop on logout"
fi

echo "[install-systemd] Done. Check status with:"
echo "  systemctl --user status $UNIT"
echo "  journalctl --user -u $UNIT -f"
