#!/usr/bin/env bash
set -euo pipefail

# The checker verifies the installed local patch before recognizing its advisory.
# Registry failures and unrelated high/critical findings remain blocking.
exec node "$(dirname "$0")/audit-dependencies.mjs" --high
