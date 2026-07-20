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

# Substitute both template tokens: __PROJECT_DIR__ and the __WRAPPER__ added for
# the dev-service mode (default to the prod wrapper, which exists in the repo so
# systemd-analyze can resolve ExecStart).
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__WRAPPER__|systemd-wrapper.sh|g" \
  "$SCRIPT_DIR/$UNIT.service" > "$TARGET"
systemd-analyze verify "$TARGET"
echo "[verify-systemd-unit] OK: unit is valid"
rm -rf "$TMP"
