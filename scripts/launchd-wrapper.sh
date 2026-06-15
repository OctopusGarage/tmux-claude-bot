#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/resolve-node.sh
. "$SCRIPT_DIR/resolve-node.sh"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Pin the state-file home to this install dir explicitly (covers a non-default
# install location and never depends on cwd or the bundle's file layout).
export TCB_STATE_DIR="$PROJECT_DIR"
cd "$PROJECT_DIR"

# Run the bundled CLI (built by install.sh via `npm run build`). No tsx loader:
# the dist is plain node ESM, so a restart runs whatever was last built.
exec "$NODE_BIN" "$PROJECT_DIR/dist/cli.js" run
