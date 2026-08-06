# Home Operator Workspace

This directory is managed by tmux-claude-bot for the Home Operator session.

It is intentionally separate from product repositories and Loop worker
worktrees. Use it for operator context, discovery, and controlled delegation
through the `tcb` CLI or future role-scoped MCP tools.

Files:

- `CLAUDE.md`: Claude Code operator instructions.
- `AGENTS.md`: Codex/cross-agent operator instructions.

Do not treat this directory as authority to mutate arbitrary projects. The bot
control service remains responsible for target resolution, conflict checks, and
WorkOrder boundaries.
