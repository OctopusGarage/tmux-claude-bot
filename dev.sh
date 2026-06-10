#!/bin/bash
# Local dev with hot-reload, borrowing the DEPLOYED (prod) config so code changes
# take effect immediately against the real token / proxy / Feishu / Claude command
# -- no second .env to drift. Pauses the managed launchd service first (the same
# token would 409) and resumes it on exit, for a seamless prod <-> dev switch.
set -euo pipefail
cd "$(dirname "$0")"

LABEL="com.octopusgarage.tmux-claude-bot"
PROD_ENV="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}/.env"

if [ ! -f "$PROD_ENV" ]; then
  echo "No deployed config at $PROD_ENV." >&2
  echo "Install first (curl ... | bash), or set TMUX_CLAUDE_BOT_DIR to the install dir." >&2
  exit 1
fi

PAUSED=0
if launchctl list "$LABEL" >/dev/null 2>&1; then
  echo "=> Pausing managed service to avoid a 409 (resumes on exit)..."
  npm run service:pause || true
  PAUSED=1
fi

resume() {
  if [ "$PAUSED" = "1" ]; then
    echo ""
    echo "=> Resuming managed service..."
    # bootstrap right after a bootout can hit a transient I/O error; retry once.
    npm run service:resume 2>/dev/null || { sleep 3; npm run service:resume || true; }
  fi
}
trap resume EXIT INT TERM

echo "=> Dev mode: clone code + deployed config ($PROD_ENV), hot-reload."
echo "   Edit and save -> reloads instantly. Ctrl-C to stop and resume prod."
TCB_ENV_FILE="$PROD_ENV" npm run dev
