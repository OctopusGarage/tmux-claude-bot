#!/usr/bin/env sh
set -eu

case "${LOOP_SKILL_ACTION:-}" in
  install|update|keep)
    if [ -f "$HOME/.agents/skills/${LOOP_SKILL_ID}/SKILL.md" ] ||
       [ -f "$HOME/.codex/skills/${LOOP_SKILL_ID}/SKILL.md" ] ||
       [ -f "$HOME/.claude/skills/${LOOP_SKILL_ID}/SKILL.md" ]; then
      exit 0
    fi
    echo "approved skill is not installed locally: ${LOOP_SKILL_ID}" >&2
    exit 1
    ;;
  remove)
    exit 0
    ;;
  *)
    echo "unsupported loop skill action: ${LOOP_SKILL_ACTION:-}" >&2
    exit 1
    ;;
esac
