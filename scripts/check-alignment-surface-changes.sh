#!/usr/bin/env bash
set -euo pipefail

changed_files="$(git diff --cached --name-only --diff-filter=ACMR)"

if [ -z "$changed_files" ]; then
  exit 0
fi

touches_alignment_surface=false
touches_alignment_evidence=false

while IFS= read -r file; do
  case "$file" in
    src/adapters/*|src/cli.ts|src/tui/*|src/core/loop/*|src/core/autopilot/*|src/core/opportunities/*|src/core/tasks/*|src/core/runtime-guardian/*|src/core/notifications/*|src/core/prompts/*|.agents/skills/*|.claude/commands/*|.claude/skills/*)
      touches_alignment_surface=true
      ;;
  esac

  case "$file" in
    docs/automation-alignment.md|docs/automation-capability-matrix.md|docs/intelligent-automation.md|docs/prompt-governance.md|docs/commands.md|docs/manual.md|docs/tui.md|docs/agents/usage-guide.md|tests/*)
      touches_alignment_evidence=true
      ;;
  esac
done <<EOF
$changed_files
EOF

if [ "$touches_alignment_surface" = true ] && [ "$touches_alignment_evidence" = false ]; then
  cat >&2 <<'EOF'
alignment surface changed without matching docs/tests evidence.

Update the relevant alignment docs or add/update a focused contract test in the
same commit. See docs/automation-alignment.md.
EOF
  exit 1
fi
