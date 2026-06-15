#!/bin/bash
# Sourced by scripts/launchd-wrapper.sh and scripts/systemd-wrapper.sh: resolve a
# usable node into $NODE_BIN (prefer the latest nvm node, else `command -v node`),
# exiting 1 if none is found. Not meant to be executed directly.
NODE_BIN=""
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
  if [ -n "$LATEST" ]; then
    NODE_BIN="$HOME/.nvm/versions/node/$LATEST/bin/node"
  fi
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "[tcb] node not found. Ensure nvm or node is installed." >&2
  exit 1
fi
