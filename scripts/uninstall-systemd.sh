#!/bin/bash
# Stop and remove the tmux-claude-bot systemd --user service (Linux). Idempotent.
set -euo pipefail

UNIT="tmux-claude-bot"
TARGET="$HOME/.config/systemd/user/$UNIT.service"

if [ -f "$TARGET" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$TARGET"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "[uninstall-systemd] Removed $TARGET"
else
  echo "[uninstall-systemd] No unit installed at $TARGET"
fi
