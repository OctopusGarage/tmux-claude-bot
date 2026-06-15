#!/bin/bash
# Render the systemd unit and validate it with systemd-analyze. CI-only helper:
# a live `systemctl --user enable` can't run on GH runners (no user session
# bus), but unit-file validity can be checked here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
UNIT="tmux-claude-bot"
TMP="$(mktemp -d)"
TARGET="$TMP/$UNIT.service"

sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$SCRIPT_DIR/$UNIT.service" > "$TARGET"
systemd-analyze verify "$TARGET"
echo "[verify-systemd-unit] OK: unit is valid"
rm -rf "$TMP"
