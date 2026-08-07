#!/usr/bin/env bash
set -euo pipefail

tracked_live_state="$(git diff --cached --name-only --diff-filter=ACMR -- state)"

if [ -z "$tracked_live_state" ]; then
  exit 0
fi

cat >&2 <<'EOF'
Live runtime state must not be committed under state/.

Keep runtime data in TCB_STATE_DIR or a dedicated private backup repository.
Use synthetic fixtures under tests/ when test data is required.
EOF
exit 1
