#!/bin/bash
# Managed DEV instance: run the hot-reloading supervisor from THIS repo checkout,
# borrowing the deployed prod state/.env so it is the same bot (same token,
# projects, queue) -- edits to repo src/ go live via the supervisor's tsc gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/resolve-node.sh
. "$SCRIPT_DIR/resolve-node.sh"
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PROD_DIR="${TMUX_CLAUDE_BOT_DIR:-$HOME/.tmux-claude-bot}"
if [ -f "$PROD_DIR/state/.env" ]; then
  STATE_DIR="$PROD_DIR/state"
elif [ -f "$PROD_DIR/.env" ]; then
  STATE_DIR="$PROD_DIR"
else
  echo "dev-launchd-wrapper: no deployed config at $PROD_DIR/state/.env" >&2
  exit 1
fi
export TCB_STATE_DIR="$STATE_DIR"
export TCB_ENV_FILE="$STATE_DIR/.env"
export TCB_LOG_DIR="$PROD_DIR/logs"
cd "$REPO_DIR"

# Run the supervisor (it spawns/reloads `tsx src/index.ts`). No bundling.
exec "$NODE_BIN" "$REPO_DIR/node_modules/.bin/tsx" "$REPO_DIR/src/scripts/dev-supervisor.ts"
