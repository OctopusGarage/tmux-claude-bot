#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if npm audit --audit-level=high >"$tmp" 2>&1; then
  cat "$tmp"
  exit 0
fi

cat "$tmp"

if grep -Eqi 'invalid json response body|audit endpoint returned an error|FETCH_ERROR' "$tmp"; then
  printf '\n==> warning: npm audit endpoint returned an invalid transport response; treating this as an external audit service failure, not a dependency finding.\n' >&2
  printf '==> rerun npm audit --audit-level=high when the registry response is healthy.\n' >&2
  exit 0
fi

exit 1
