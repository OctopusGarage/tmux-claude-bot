#!/bin/bash
# Local dev with hot-reload, borrowing the DEPLOYED (prod) config so code changes
# take effect immediately against the real token / proxy / Feishu / Claude command
# -- no second .env to drift. Pauses the managed service first (launchd on macOS,
# systemd --user on Linux; the same token would 409) and resumes it on exit, for
# a seamless prod <-> dev switch.
set -euo pipefail
cd "$(dirname "$0")"

PROD_DIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}"
# Config (.env) and state live in the state/ subdir since the state-dir split;
# fall back to the install root for pre-split installs.
if [ -f "$PROD_DIR/state/.env" ]; then
  STATE_DIR="$PROD_DIR/state"
elif [ -f "$PROD_DIR/.env" ]; then
  STATE_DIR="$PROD_DIR"
else
  echo "No deployed config at $PROD_DIR/state/.env (or $PROD_DIR/.env)." >&2
  echo "Install first (curl ... | bash), or set TMUX_CLAUDE_BOT_DIR to the install dir." >&2
  exit 1
fi
PROD_ENV="$STATE_DIR/.env"

# Pause the managed service (launchd/systemd) only if it's actually up; service.sh
# owns the per-OS "is it running" check so we don't duplicate the branch here.
PAUSED=0
if scripts/service.sh running; then
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

echo "=> Dev mode: clone code + deployed config ($PROD_ENV) + deployed state, hot-reload."
echo "   Edit and save -> reloads instantly. Ctrl-C to stop and resume prod."
# Borrow prod's state dir too (recent_projects / session_path_map / current
# project) so dev mirrors the real projects instead of the checkout's files.
TCB_ENV_FILE="$PROD_ENV" TCB_STATE_DIR="$STATE_DIR" npm run dev
