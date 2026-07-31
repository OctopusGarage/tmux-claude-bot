# Automation Alignment Contract

This document is the alignment contract for tmux-claude-bot's agent-facing
instructions, user-facing surfaces, intelligent automation modules, and
maintenance documentation. It exists because this project now has several
surfaces that can drift independently: Claude Code project memory, Codex
`AGENTS.md`, repo skills, `.claude` commands, CLI commands, the TUI, Telegram,
Feishu/Lark, Loop Engineering, Autopilot, Opportunity Discovery, PR review,
Daily Task Audit, Runtime Guardian, and docs.

For the current intelligent-automation business model, read
`docs/intelligent-automation.md`. For user-facing command usage, read
`docs/manual.md`, `docs/commands.md`, `docs/tui.md`, and
`docs/agents/usage-guide.md`. For surface-by-surface feature parity, read
`docs/automation-capability-matrix.md`.

## External Guidance Baseline

Use official tool behavior as the baseline when deciding where a rule belongs:

- Claude Code loads `CLAUDE.md` / `.claude/CLAUDE.md` as project memory. Keep it
  concise and use it for project standards, architecture decisions, build/test
  commands, and review checklists. Larger procedure-like material should move
  into skills or scoped rules.
- Claude Code skills and old `.claude/commands/*.md` both create slash-command
  workflows. Prefer skills for reusable procedures with references, scripts, or
  optional automatic invocation. Keep `.claude/commands` as thin compatibility
  entry points when needed.
- Claude Code hooks are deterministic lifecycle automation. Use hooks for
  enforceable checks around tool use or session lifecycle, not for long business
  explanations.
- Codex reads `AGENTS.md` files as durable repository guidance. Nested
  `AGENTS.override.md` / `AGENTS.md` files can specialize subdirectories.
- Codex skills package repeatable workflows and load only when selected or
  relevant. Use skills for reusable operator recipes; do not put long task
  procedures in always-loaded guidance.
- Codex hooks can observe or block supported tool calls and session events, but
  hook output must stay concise and should not leak secrets.
- ChatGPT/Codex scheduled tasks can run in local projects or isolated worktrees.
  Prefer worktrees for unattended code-changing work; use source worktrees only
  for explicit live/self-repair flows with clean-worktree preflight.

Memory and instruction files are context, not a policy engine. If a rule must be
enforced, add a schema check, contract test, hook, runtime gate, or CI/local
verification command.

## Rule Placement

Use the smallest durable surface that matches the scope:

| Surface | Use For | Do Not Use For |
| --- | --- | --- |
| `AGENTS.md` | Cross-agent repository rules Codex and other coding agents must see immediately. Keep it short, strict, and pointer-heavy. | Long tutorials, historical design notes, or feature matrices. |
| `CLAUDE.md` | Claude Code project memory: development conventions, service/runtime facts, logging, verification, architecture constraints. | Full product manuals or repeated copies of intelligent automation docs. |
| `docs/intelligent-automation.md` | Business truth for Loop Engineering, Supervisor, WorkOrder, Autopilot, Opportunity Discovery, PR review, Daily Task Audit, Runtime Guardian. | Tool-specific memory mechanics or one-off historical plans. |
| `docs/automation-alignment.md` | Alignment checklist and source-of-truth map across agent instructions, docs, commands, channels, config, and tests. | User-facing command reference. |
| `docs/automation-capability-matrix.md` | Surface-by-surface capability parity for CLI, TUI, Telegram, Feishu/Lark, and the home/operator skill. | Deep implementation details or task-family business truth. |
| `docs/manual.md`, `docs/commands.md`, `docs/tui.md` | Human-facing usage and command behavior. | Internal-only design constraints unless needed to explain user behavior. |
| `docs/agents/usage-guide.md` | AI operator recipes for using the installed bot. | Source-code implementation details that can drift from CLI help. |
| `skills/tmux-claude-bot/SKILL.md` | Installed home/operator session recipe for driving `tcb`. | A second source of truth for product behavior; link back to docs. |
| `.agents/skills/*` | Codex-compatible repo workflows that should load on demand. | Always-on repo rules. |
| `.claude/skills/*` | Claude Code reusable workflows with references/scripts. | Short one-off reminders that belong in `CLAUDE.md`. |
| `.claude/commands/*` | Legacy/thin slash-command compatibility. Prefer a skill for new reusable workflows. | New long-lived workflow truth. |
| `.claude/rules/*` or nested instruction files | Scoped rules for specific directories/file types when always-loaded files get too large. | Global automation taxonomy. |
| `src/**` schema/gates/tests | Enforced behavior and contracts. | Human-only prose. |

## Alignment Matrix

When adding, renaming, removing, or changing a user-visible or automation-visible
feature, review this matrix in the same slice:

| Feature Area | Must Align |
| --- | --- |
| Chat command | `BOT_COMMANDS`, Telegram handler, Lark command/card action, help text, `docs/commands.md`, i18n catalogs, command tests. |
| Control button/card action | Telegram keyboard/callback parser, Lark card/action parser, TUI when applicable, dangerous-action confirmation, parity tests. |
| CLI command | `src/cli.ts`, control protocol/client/server if socket-backed, `docs/manual.md`, `docs/agents/usage-guide.md`, CLI tests. |
| TUI action | TUI keymap/help text, control client protocol, user docs, tests. If intentionally unsupported, document the reason. |
| Notification workflow | `NotificationGateway`, Telegram sender, Lark sender, project-bound Lark group routing, attachment behavior, delivery evidence, Daily Task Audit visibility, tests. |
| Loop task family | Config schema, scheduler, WorkOrder builder, supervisor prompt, execution worktree policy, conflict model, system gate, report/ledger, docs, tests. |
| Workspace task | Project-level behavior plus workspace repository path policy, per-repo PR/branch policy, cross-repo verification, docs/tests proving the task is not architecture-only. |
| Repository-wide PR review | `prReview.repositories` config, GitHub account binding, per-PR review gate, repair policy, mergeability/CI checks, switch-back, docs/tests. |
| Autopilot delegation | Chat command, control socket, Telegram/Lark/TUI button, WorkOrder creation, conflict blocking, notification, opportunity completion when related, docs/tests. |
| Opportunity Discovery | Read-only WorkOrder, dedupe/store, concise Telegram/Lark suggestions, discussion actions, Autopilot handoff, project conflict blocking, docs/tests. |
| Daily Task Audit | Active discovery, ledger merge, self-audit recursion, auto-repair dispatch, final Telegram/Feishu notification, repair-status closure, docs/tests. |
| Runtime Guardian | Runtime artifact detection, evidence threshold, source/isolated worktree policy, self-repair dispatch, clean-worktree gate, cooldown, docs/tests. |
| GitHub operations | Configured `githubAccount`, command-local `GH_TOKEN` from `gh auth token --user`, all `gh api/pr/run/repo` commands, security alert reads, tests. |
| Worktree/session isolation | Source path validation, isolated/source/auto policy, supervisor session, worker session, lease cleanup, ordinary chat blocking, logs/artifacts, tests. |
| AI/eval behavior | Agent-backed/control-surface path only, no direct model-provider SDK/API calls, deterministic fallback, review/eval evidence, docs/tests. |

## Drift Audit Checklist

Run this checklist before claiming an automation or cross-surface feature is
complete:

1. Name the canonical module and source of truth.
2. List every user/control surface that should expose it: CLI, TUI, Telegram,
   Feishu/Lark, control socket, home/operator skill, scheduled config.
   Update `docs/automation-capability-matrix.md` when the support shape changes.
3. State any intentional surface difference and the user-facing fallback.
4. Confirm docs mention the feature in the right layer and do not duplicate a
   stale older design.
5. Confirm generated or installed skills point to the current docs instead of
   copying outdated behavior.
6. Add or update a contract test for every mechanical alignment rule that can
   drift.
7. For code-changing automation, prove conflict handling, worktree/session
   isolation, GitHub account binding, verification gates, final notification,
   and audit visibility.
8. For notification features, prove Telegram and Feishu/Lark capability parity,
   and prove Lark project-bound group routing when a session is known.
9. Mark historical documents as historical when they no longer describe current
   behavior.

If an item cannot be aligned in the same slice, document the gap with an owner,
reason, and follow-up test or issue. Do not leave silent drift.

## Known Alignment Gaps To Investigate

No open alignment gaps are currently recorded here.

When a new gap is found, add it here with the affected surfaces, why it cannot
be completed in the current slice, and the test or runtime evidence needed to
close it. Do not leave silent drift in source, docs, skills, commands, or chat
surfaces.
