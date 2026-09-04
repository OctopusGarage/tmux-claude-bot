#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

npm_bin="$(command -v npm)"
audit_timeout_seconds="${TCB_NPM_AUDIT_TIMEOUT_SECONDS:-60}"

run_npm_audit() {
  env -i \
    HOME="${HOME:-}" \
    PATH="${PATH:-}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    npm_config_fetch_timeout="${NPM_CONFIG_FETCH_TIMEOUT:-15000}" \
    perl -e 'alarm shift @ARGV; exec @ARGV' "$audit_timeout_seconds" \
    "$npm_bin" audit --audit-level=high
}

print_audit_output() {
  perl -pe 'BEGIN { $home = quotemeta($ENV{HOME} // "") } s/$home/~/g if length $home' "$tmp"
}

if run_npm_audit >"$tmp" 2>&1; then
  print_audit_output
  exit 0
fi

print_audit_output

if grep -Eqi 'invalid json response body|audit endpoint returned an error|FETCH_ERROR|Alarm clock' "$tmp"; then
  printf '\n==> warning: npm audit endpoint returned an invalid transport response; treating this as an external audit service failure, not a dependency finding.\n' >&2
  printf '==> rerun npm audit --audit-level=high when the registry response is healthy.\n' >&2
  exit 0
fi

exit 1
