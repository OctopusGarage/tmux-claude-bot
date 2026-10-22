#!/usr/bin/env bash
set -euo pipefail

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

pnpm_bin="$(command -v pnpm)"
audit_timeout_seconds="${TCB_PNPM_AUDIT_TIMEOUT_SECONDS:-${TCB_NPM_AUDIT_TIMEOUT_SECONDS:-60}}"

run_pnpm_audit() {
  env -i \
    HOME="${HOME:-}" \
    PATH="${PATH:-}" \
    TMPDIR="${TMPDIR:-/tmp}" \
    npm_config_fetch_timeout="${NPM_CONFIG_FETCH_TIMEOUT:-15000}" \
    perl -e 'alarm shift @ARGV; exec @ARGV' "$audit_timeout_seconds" \
    "$pnpm_bin" audit --audit-level high
}

print_audit_output() {
  perl -pe 'BEGIN { $home = quotemeta($ENV{HOME} // "") } s/$home/~/g if length $home' "$tmp"
}

if run_pnpm_audit >"$tmp" 2>&1; then
  print_audit_output
  exit 0
fi

print_audit_output

if grep -Eqi 'invalid json response body|audit endpoint returned an error|FETCH_ERROR|Alarm clock' "$tmp"; then
  printf '\n==> warning: pnpm audit endpoint returned an invalid transport response; treating this as an external audit service failure, not a dependency finding.\n' >&2
  printf '==> rerun pnpm audit --audit-level high when the registry response is healthy.\n' >&2
  exit 0
fi

exit 1
