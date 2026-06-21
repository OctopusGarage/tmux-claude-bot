#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/resolve-node.sh
. "$SCRIPT_DIR/resolve-node.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# State lives in the install dir's `state/` subdir, NOT the install dir itself:
# the deploy re-mirrors the install dir with `rsync --delete` and would wipe any
# state at the root (this is what erased group_bindings.json). `.env` lives there
# too. Logs stay at the install-dir root (excluded from the deploy as `/logs`).
export TCB_STATE_DIR="$PROJECT_DIR/state"
export TCB_ENV_FILE="$PROJECT_DIR/state/.env"
export TCB_LOG_DIR="$PROJECT_DIR/logs"
cd "$PROJECT_DIR"

# Keep-awake (TCB_KEEP_AWAKE) is handled inside the bot process (caffeinate spawned
# from src/core/platform/keep-awake.ts), NOT here -- so it works the same for the
# managed service, `npm run dev`, and a manual run. See that module.

# Run the bundled CLI (built by install.sh via `npm run build`). No tsx loader:
# the dist is plain node ESM, so a restart runs whatever was last built.
exec "$NODE_BIN" "$PROJECT_DIR/dist/cli.js" run
