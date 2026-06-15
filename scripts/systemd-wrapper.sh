#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/resolve-node.sh
. "$SCRIPT_DIR/resolve-node.sh"

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Pin the state-file home to this install dir (covers non-default locations and
# never depends on cwd or bundle layout).
export TCB_STATE_DIR="$PROJECT_DIR"
cd "$PROJECT_DIR"

# Run the bundled CLI (built by install.sh via `npm run build`). No tsx loader:
# dist is plain node ESM, so a restart runs whatever was last built.
exec "$NODE_BIN" "$PROJECT_DIR/dist/cli.js" run
