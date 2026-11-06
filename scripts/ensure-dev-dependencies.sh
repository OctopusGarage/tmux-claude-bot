#!/bin/bash
# Sourced by managed dev wrappers before starting the TypeScript supervisor.
tcb_ensure_dev_dependencies() {
  local repo_dir="$1"
  if [ -x "$repo_dir/node_modules/.bin/tsx" ] &&
     [ -x "$repo_dir/node_modules/.bin/tsc" ]; then
    return 0
  fi
  echo "[tcb] Missing development dependencies; restoring from lockfile." >&2
  (
    cd "$repo_dir"
    export PATH="$(dirname "${NODE_BIN:-$(command -v node)}"):$PATH"
    if command -v pnpm >/dev/null 2>&1; then
      pnpm install --frozen-lockfile
    elif command -v corepack >/dev/null 2>&1; then
      COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile
    else
      echo "[tcb] Cannot restore dependencies: pnpm/corepack unavailable." >&2
      exit 1
    fi
  ) || return $?
  if [ ! -x "$repo_dir/node_modules/.bin/tsx" ] ||
     [ ! -x "$repo_dir/node_modules/.bin/tsc" ]; then
    echo "[tcb] Dependency restoration did not provide tsx and tsc." >&2
    return 1
  fi
}
