#!/usr/bin/env bash
set -euo pipefail

run() {
  printf '\n==> %s\n' "$*"
  "$@"
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
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  run scripts/verify-systemd-unit.sh
else
  printf '\n==> skip systemd unit validation: systemd-analyze not found\n'
fi

printf '\nverify-local ok\n'
