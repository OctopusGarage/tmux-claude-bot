#!/bin/bash
# Dispatch service install to the platform's manager (launchd / systemd --user).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
case "$(uname)" in
  Darwin) exec "$SCRIPT_DIR/install-launchd.sh" ;;
  Linux)  exec "$SCRIPT_DIR/install-systemd.sh" ;;
  *) echo "unsupported OS: $(uname) (tmux-claude-bot supports macOS and Linux)" >&2; exit 1 ;;
esac
