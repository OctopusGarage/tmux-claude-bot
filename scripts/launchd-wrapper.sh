#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Resolve node: prefer nvm (works without PATH setup), fallback to which(1)
NODE_BIN=""
if [[ -d "$HOME/.nvm/versions/node" ]]; then
  LATEST="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$LATEST" ]]; then
    NODE_BIN="$HOME/.nvm/versions/node/$LATEST/bin/node"
  fi
fi
if [[ -z "$NODE_BIN" ]] || [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "$NODE_BIN" ]] || [[ ! -x "$NODE_BIN" ]]; then
  echo "[launchd-wrapper] node not found. Ensure nvm or node is installed." >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$PROJECT_DIR"

exec "$NODE_BIN" \
  --require "$PROJECT_DIR/node_modules/tsx/dist/preflight.cjs" \
  --import "file://$PROJECT_DIR/node_modules/tsx/dist/loader.mjs" \
  "$PROJECT_DIR/src/index.ts"
