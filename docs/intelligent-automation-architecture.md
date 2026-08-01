# Intelligent Automation Architecture

This document gives the end-to-end architecture view for tmux-claude-bot's
intelligent automation system. It complements `docs/intelligent-automation.md`,
which remains the task-family and business-rule source of truth.

For a compact visual map of the same system, see
`docs/intelligent-automation-ascii-architecture.md`.

## System Role

tmux-claude-bot is a local, long-running agent orchestration service. It runs
Claude Code or Codex agents inside managed tmux sessions and exposes the same
service through Telegram, Feishu/Lark, the local CLI, the TUI, scheduled jobs,
and AI-facing operator skills.

The service is the coordinator and final gatekeeper. Agents reason and adapt,
but system code verifies durable evidence before accepting a task as complete.

```text
Telegram / Feishu-Lark / TUI / CLI / scheduler
        |
        v
tmux-claude-bot service
        |
        +-- ordinary project sessions
        +-- Loop Supervisor sessions
        +-- Loop worker sessions
        +-- WorkOrders
        +-- system gates
        +-- ledger, reports, logs, notifications
        +-- Daily Task Audit and Runtime Guardian
```

## Session Model

There are three important session classes:

| Session | Responsibility | User chat context |
| --- | --- | --- |
| Ordinary project session | Interactive owner prompts, project switching, status, history, and ad hoc work. | Yes |
| Loop Supervisor session | Orchestrates bounded WorkOrders, checks progress, issues revision prompts, and produces final summaries. | No |
| Loop worker session | Executes target-project work in an isolated automation context. | No |

Scheduled jobs, Autopilot delegation, PR review, harness-auto, Daily Task Audit
repair, and Runtime Guardian repair must not be injected into ordinary project
chat. They should use reserved supervisor and worker sessions so human
conversation context stays separate from automation context.

## Core Execution Pipeline

All intelligent automation should use one pipeline:

```text
trigger
  -> resolve intent
  -> check conflicts and queue state
  -> sync configured base branch
  -> run preflight
  -> materialize WorkOrder
  -> assign Loop Supervisor
  -> lease Loop worker
  -> verify configured repository path
  -> execute, review, test, commit, and optionally open PR
  -> write supervisor final summary
  -> run system gate
  -> retry recoverable failures through bounded revision prompts
  -> notify, write ledger, release or retain worker
```

The WorkOrder is the boundary between intent and execution. It carries the
project id, project path, task kind, branch/PR policy, verification policy,
execution isolation policy, final summary path, and artifacts required by the
system gate.

## Module Responsibilities

| Module | Owns | Does not own |
| --- | --- | --- |
| Chat adapters | Telegram and Feishu/Lark commands, callbacks, cards, and message delivery. | Task-family business rules. |
| CLI and TUI | Local operator controls and diagnostics. | Independent automation semantics. |
| Loop Engineering | Scheduled project and workspace health WorkOrders. | One-off user conversation routing. |
| Autopilot | Owner-confirmed active delegation into the supervisor pipeline. | Cron, keep-alive, goal-cycle, or status across all sessions. |
| Opportunity Discovery | Read-only proposal generation and owner discussion entry points. | Implementation, branches, commits, PRs, or merge decisions. |
| PR review | Loop-created PR review or repository-wide open-PR processing. | Broad redesign or product judgment. |
| Daily Task Audit | Retrospective task audit, final owner summary, and evidence-led self-repair dispatch. | General target-project maintenance. |
| Runtime Guardian | Near-real-time self-healing for tmux-claude-bot runtime artifacts. | Target-project code maintenance. |
| Notification gateway | Channel selection, project-bound Lark routing, delivery evidence, attachments. | Per-adapter business-specific bypasses. |
| System gate | Final acceptance for output format, git state, PR, CI, mergeability, branch switch-back, and notification evidence. | AI judgment or product decisions. |

## Task Families

Loop Engineering supports project and workspace task families:

- `architecture`: improve architecture only when the score is below target.
- `bugFix`: find and fix confirmed functional or production-risk bugs.
- `testCoverage`: add meaningful tests toward configured coverage goals.
- `securityMaintenance`: fix reachable and confirmed security risks.
- `harnessAuto`: orchestrate multiple health subtasks in one run, branch, and PR.
- `opportunityDiscovery`: propose useful work without editing.
- `pullRequestReview`: review loop-created PRs for configured projects or workspaces.

`prReview.repositories` is separate from `pullRequestReview`. It processes all
open PRs for configured repositories and may repair only narrow, deterministic,
same-repository issues before merging.

Workspace tasks are generic multi-repository WorkOrders, not architecture-only
jobs. The internal `workspace-architecture` name is a compatibility job kind,
not the workspace capability boundary.

## Isolation And Conflict Control

Default code-changing automation should run in isolated worktrees. Source
worktree execution is reserved for explicit live/self-repair flows such as
Runtime Guardian fast-heal, and only after clean-worktree preflight.

Conflict rules:

- Only one code-changing automation should own a project or branch at a time.
- `harnessAuto` consumes overlapping architecture, bug-fix, test-coverage, and
  security-maintenance work for the same resource.
- Ordinary chat prompts should block when active automation owns the project,
  while read-only diagnostics and escape controls remain available.
- PR review should not repair a branch while its originating WorkOrder still owns it.
- Opportunity discussion or delegation should block on active automation or dirty
  worktrees.
- Repository-wide PR review must not repair fork PRs, drafts, merge-conflict
  branches, broad refactors, migrations needing product judgment, or unclear
  security changes.

## Evidence And Acceptance

A supervised task is not complete just because an agent says it is complete.
Completion requires durable evidence:

- strict supervisor final summary
- `system-gate.json`
- git clean/branch state
- PR URL or report-only reason when applicable
- CI and mergeability state when applicable
- verification commands and results
- notification delivery evidence
- ledger/report artifacts

Recoverable failures should be sent back to the same supervisor through bounded
revision prompts. Non-recoverable blockers, such as missing GitHub permissions,
should fail with precise evidence.

## Notification Model

All long-running automation should route through the notification gateway.
Project-related Feishu/Lark messages prefer the project-bound group when a
session is known, then fall back according to the configured owner/private
targets. Telegram currently uses owner-directed delivery unless a feature
explicitly configures a different target.

Telegram and Feishu/Lark must maintain functional parity. Cards, buttons, and
inline keyboards may differ, but the user should be able to accomplish the same
workflows on both channels unless the difference is explicitly documented.

## GitHub Identity

GitHub automation must use the configured project or repository account. Shell
commands should use command-local tokens:

```bash
GH_TOKEN="$(gh auth token --user <account>)" gh ...
```

This applies to `gh api`, `gh pr`, `gh run`, security-alert reads, PR creation,
mergeability checks, CI checks, and merges. Missing permissions are blockers,
not code failures.

## AI Boundary

This project is not a model-client application. AI-backed judgment must reuse
managed Claude Code or Codex sessions through the bot/control surface.

Do not add provider SDKs, model API keys, direct model HTTP calls, or helper
scripts that bypass the active-agent architecture. Labels such as `aiEval` are
quality-gate labels, not permission to create a second model integration path.

## Drift Risks And Controls

These are the recurring risks and the concrete controls that should prevent,
detect, or recover from them.

| Risk | Prevent | Detect | Recover |
| --- | --- | --- | --- |
| Telegram and Feishu/Lark drift apart | Update both adapters or document an intentional channel difference in `docs/automation-capability-matrix.md`. | Channel parity tests and docs-contract checks. | Add the missing command/card/callback and backfill a regression test. |
| CLI, TUI, docs, and skills disagree | Keep CLI detail in `docs/cli-reference.md`; keep user workflows in `docs/manual.md`; keep skills pointer-heavy. | `tests/docs-contract.test.ts` derives CLI commands/options from `src/cli.ts`. | Fix docs and add a contract assertion for the drift pattern. |
| A new task family bypasses WorkOrder/system gates | Require new automation to materialize a WorkOrder and reuse supervisor, worker, ledger, and notification paths. | Config, work-order, scheduler, and service tests. | Move side-channel prompts into a WorkOrder policy and add gate tests. |
| Runtime repair edits the wrong repository | Store authoritative `projectPath`, validate git toplevel, and use source mode only for explicit self-repair. | Worktree/session isolation tests and runtime-guardian tests. | Block the run, retain artifacts, and dispatch tmux-claude-bot self-repair only when evidence is confirmed. |
| PR review overreaches into broad changes | Limit repair to narrow, deterministic, same-repository issues and require CI/mergeability evidence. | Per-PR review gate output and PR review tests. | Mark blocked with evidence instead of editing or merging. |
| Opportunity Discovery starts implementing ideas | Keep discovery read-only and route approved work through Autopilot. | WorkOrder tests assert no branch/commit/PR behavior for opportunity tasks. | Dismiss bad suggestions or delegate approved ones through supervisor-backed Autopilot. |
| Harness-auto duplicates child tasks | Treat harness-auto as a containing task in conflict planning. | Scheduler/service conflict tests. | Skip or wait overlapping standalone jobs and record the reason. |
| Agent claims success without durable proof | Require final summary plus `system-gate.json` and verification artifacts. | Daily Task Audit compares supervisor output with system gate evidence. | Send bounded revision prompts or dispatch repair. |
| GitHub commands use the wrong account | Use configured `githubAccount` and command-local `GH_TOKEN`. | Tests and logs should include selected account without leaking tokens. | Fail with a permission blocker and update config if the account is wrong. |
| Direct model API paths slip in | Keep AI work active-agent-only. | Docs-contract dependency/API pattern checks. | Remove provider clients and replace with control-surface or deterministic commands. |

## Maintenance Rule

When adding or changing intelligent automation, update the smallest authoritative
surface and one enforcement layer in the same slice:

1. Source schema/runner/gate for behavior.
2. `docs/intelligent-automation.md` for business rules.
3. `docs/automation-capability-matrix.md` for surface parity.
4. `docs/automation-alignment.md` for cross-surface governance.
5. A focused test or runtime gate for every drift pattern that can be automated.

Do not rely on prose alone for rules that affect safety, merge behavior,
notification delivery, or unattended code changes.
