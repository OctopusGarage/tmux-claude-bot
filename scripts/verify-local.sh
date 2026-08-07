#!/usr/bin/env bash
set -euo pipefail

. "$(dirname "$0")/git-worktree-config-guard.sh"
export TCB_GIT_CONFIG_EXIT_SETTLE_SECONDS=${TCB_GIT_CONFIG_EXIT_SETTLE_SECONDS:-1}
install_git_worktree_config_guard

run() {
  printf '\n==> %s\n' "$*"
  git_worktree_config_checkpoint "verify-local:before:$*"
  set +e
  "$@"
  status=$?
  set -e
  git_worktree_config_checkpoint "verify-local:after:$*:status=$status"
  return "$status"
}

run npm run lint
run npm run lint:types
run npm run lint:types:tests
run npm run test:coverage
run npm run knip
run npm run depcruise
run npm run lint:deep
run npm run smoke
run scripts/audit-high.sh

if command -v shellcheck >/dev/null 2>&1; then
  run npm run lint:sh
else
  printf '\n==> skip shellcheck: command not found\n'
  git_worktree_config_checkpoint "verify-local:skip:shellcheck"
fi

git_worktree_config_checkpoint "verify-local:before-systemd-check"
if command -v systemd-analyze >/dev/null 2>&1; then
  run scripts/verify-systemd-unit.sh
else
  printf '\n==> skip systemd unit validation: systemd-analyze not found\n'
  git_worktree_config_checkpoint "verify-local:skip:systemd-analyze"
fi

git_worktree_config_checkpoint "verify-local:before-success"
printf '\nverify-local ok\n'
