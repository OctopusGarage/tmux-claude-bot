#!/bin/bash
# Resolve the dev profile, then exec the given command with the right state/env
# dir. Default: borrow the deployed (prod) ~/.tmux-claude-bot config+state when it
# exists, so dev mirrors the real projects; TCB_DEV_LOCAL=1 forces the repo's own
# .env + local state; no prod install falls back to the repo. An explicit
# TCB_STATE_DIR/TCB_ENV_FILE always wins. Used by `npm run dev`.
set -euo pipefail
P="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}"
if [ -z "${TCB_DEV_LOCAL:-}" ] && [ -f "$P/.env" ]; then
  D="$P"
else
  D="$PWD"
fi
export TCB_STATE_DIR="${TCB_STATE_DIR:-$D}"
export TCB_ENV_FILE="${TCB_ENV_FILE:-$D/.env}"
exec "$@"
