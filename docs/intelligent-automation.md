# Intelligent Automation

This document is the maintenance map for tmux-claude-bot's intelligent
automation features. It defines the names, ownership boundaries, execution flow,
and configuration relationships so future changes do not blur Loop Engineering,
Loop Supervisor, Autopilot, Opportunity Discovery, PR review, or Daily Task
Audit.

For command-level usage, see `docs/manual.md`, `docs/commands.md`, and
`docs/agents/usage-guide.md`.

## System Model

tmux-claude-bot is the long-running local service. Telegram, Feishu/Lark, the
TUI, and the CLI are client surfaces that drive the same service.

```text
Telegram / Feishu / TUI / CLI
        |
        v
tmux-claude-bot service
        |
        +-- project agent sessions: Claude/Codex inside target project tmux panes
        +-- Loop Supervisor sessions: reserved Claude/Codex workers for WorkOrders
        +-- system gates: output, git, PR, CI, mergeability, switch-back checks
        +-- state/logs/ledger: run reports, task audit evidence, notifications
```

The bot is the coordinator and final gatekeeper. Agents may reason and adapt,
but system-level code still verifies required outputs, worktree state, PR status,
CI, mergeability, notification delivery, and branch switch-back.

## Terms

| Term | Meaning | Not This |
| --- | --- | --- |
| Project agent | The Claude/Codex session attached to one target repository. | The final authority for PR/CI gates. |
| Loop Engineering | Scheduled project/workspace health platform. | One-off user delegation. |
| Loop Supervisor | Reserved Claude/Codex worker that executes bounded WorkOrders. | A replacement for system gates. |
| WorkOrder | The strict task contract passed to a supervisor. | An open-ended chat prompt. |
| Autopilot | Active delegation of a user-confirmed current task to Loop Supervisor. | Legacy keep-alive, cron, or goal-cycle UI. |
| Opportunity Discovery | Read-only suggestion generation before owner approval. | Implementation or PR creation. |
| Daily Task Audit | Bot-owned scheduled task audit and auto-repair loop. | General project health maintenance. |
| `pullRequestReview` | Project/workspace loop-created PR review. | Repository-wide open PR processing. |
| `prReview.repositories` | Repository-wide all-open-PR queue processing. | Only loop-created PRs. |
| Batch Scheduler | Generic batch plan scheduler controlled by `BATCH_SCHEDULER_*`. | Autopilot. |

Legacy names may remain for compatibility, but new behavior should use the
current terms above. In particular, `AUTOPILOT_SCHEDULER_*` is only a legacy
alias for `BATCH_SCHEDULER_*`.

## Execution Flow

Scheduled Loop Engineering and active Autopilot delegation use the same
supervised execution shape:

```text
trigger
  -> discover/validate due task
  -> conflict and queue checks
  -> sync latest base branch
  -> preflight environment checks
  -> materialize bounded WorkOrder
  -> assign Loop Supervisor
  -> supervisor analyzes, verifies, edits, and reports
  -> write strict final summary JSON
  -> system gate validates marker, summary, git state, PR, CI, mergeability
  -> recoverable failures are sent back to the same supervisor
  -> final PR merge or report-only completion
  -> switch back to configured base branch
  -> fast-forward local base branch
  -> write logs, ledger, reports, notifications
```

The supervisor must not be detached just because it printed something that looks
done. The system gate owns completion. If the summary is malformed, PR checks are
pending, the worktree is dirty, the branch is wrong, or the PR body needs cleanup,
the bot should send a bounded revision prompt and re-run the gate. Non-recoverable
platform failures, such as missing GitHub permission, should fail with a concrete
blocker.

## Task Families

Loop Engineering supports these project and workspace task families:

- `architecture`: improve architecture in small verified slices. It assesses a
  score first and stops when the target score is met, commonly 95, to avoid
  optimizing for its own sake.
- `bugFix`: find and fix confirmed functional, reliability, or production-risk
  bugs. It must ignore nits, style preferences, and feature requests.
- `testCoverage`: raise meaningful test coverage, commonly toward 80%. It must
  add tests for real behavior and plausible regressions, not metric-padding tests.
  If coverage work exposes a real bug, fix it narrowly and add regression
  coverage when practical.
- `securityMaintenance`: find and fix confirmed security risks, including
  dependency advisories, GitHub security findings, static analysis, secret
  exposure, auth boundaries, CORS, file/path handling, command execution,
  sensitive logging, CI secrets, and supply-chain issues. It must assess
  reachability and severity before changing code.
- `harnessAuto`: orchestrate multiple health subtasks as one run, one branch, and
  one PR. It should assess health first, select only justified enabled subtasks,
  and stop when configured health or no-confirmed-issue conditions are met.
- `opportunityDiscovery`: inspect repository evidence and propose useful feature
  or optimization opportunities. It must not edit files, create branches, commit,
  push, or open PRs.
- `pullRequestReview`: review loop-created PRs for one configured project or
  workspace, require configured clean review passes, and merge only after CI and
  mergeability are acceptable.

Workspace entries are generic multi-repository WorkOrders. They are not limited
to architecture. The internal job kind `workspace-architecture` exists only for
historical run-id compatibility.

## Autopilot

Autopilot is the active-delegation path for user-confirmed work. It is used when
the owner and agent have already clarified the requirement, or when a current
project conversation should be continued by the supervisor.

Inputs include:

- `/autopilot [requirement]`
- `/autopilot delegate [requirement]`
- `tcb autopilot <project> "<requirement>"`
- Telegram/Feishu "Continue via supervisor" actions
- Opportunity delegation after owner approval

If no explicit requirement is supplied, the supervisor should use current
session context plus repository evidence: live pane, git status, recent commits,
existing PRs, reports, and prior verification output.

Autopilot is not cron. It should reuse the Loop Supervisor WorkOrder path and the
same system gates as scheduled jobs.

## Opportunity Discovery

Opportunity Discovery is proposal generation, not execution.

The intended flow is:

```text
scheduled discovery
  -> read repository evidence
  -> write opportunities.json
  -> bot dedupes and sends concise Telegram/Feishu suggestions
  -> owner discusses or dismisses
  -> approved work enters Autopilot active delegation
```

Discussion and execution are intentionally decoupled. A suggestion message may
offer discussion actions, but implementation should go through the same active
delegation pipeline as any other user-confirmed task.

## PR Review Modes

There are two PR review surfaces:

- `pullRequestReview` is scoped to configured project/workspace loop-created PRs.
  It answers: "Did yesterday's loop task introduce a bug, fail CI, or create an
  unsafe PR?"
- `prReview.repositories` is the repository-wide open-PR queue processor. It
  answers: "Which open PRs in this repository can be reviewed, repaired narrowly
  if needed, and merged?"

Both should focus on introduced bugs, failing checks, mergeability, security,
data loss, migrations, and user-visible regressions. They should not block on
style nits.

## Daily Task Audit And Auto Repair

Daily Task Audit is the bot's self-check and self-healing schedule audit. It
discovers tmux-claude-bot-owned launchd/service and Loop Engineering tasks,
merges that expected set with the shared task ledger, sends a final Telegram /
Feishu summary, and can dispatch supervisor repair when
`TASK_AUDIT_AUTO_REPAIR=true`.

Auto-repair is evidence-led:

- state the concrete problem first
- verify it from ledger, report, log, git, scheduler, or service evidence
- classify whether it is a tmux-claude-bot bug, target-project issue, external
  service problem, auth problem, or network problem
- edit this repository only for bot-owned bugs
- run local verification and record the outcome

Daily Task Audit must also audit its own previous execution. A previous audit
that failed, timed out, left `repair-dispatch=failed|blocked|unavailable`, or
delivered only a partial/failed notification is a first-class self-repair
candidate. Self-repair records already marked `running` must not be dispatched
again until their current repair resolves.

## Conflict Rules

Automation should remain serialized where work can collide:

- One project should not run multiple code-editing jobs against the same worktree
  at the same time.
- `harnessAuto` contains architecture, bug-fix, test-coverage, and security
  maintenance. When a harness run is active or due, overlapping standalone jobs
  should skip or wait rather than create duplicate PRs.
- PR review should not repair a branch while the originating task still owns it.
- Opportunity Discovery is read-only, but discussion or delegation should block
  when the target project has active delegated work or a dirty worktree.
- Repository-wide PR review may repair only small deterministic same-repository
  PR branch failures. It must not repair fork PRs, drafts, conflicts, broad
  refactors, or changes needing product/security design judgment.

## Notification Rules

Telegram and Feishu/Lark should maintain capability parity. Feishu may use
project-bound groups and interactive cards; Telegram may use inline keyboards,
slash commands, or concise text actions. The standard is functional parity, not
identical UI.

Project-related notifications should route to the bound project group when the
channel supports it, then fall back to owner/private targets according to the
notification gateway policy. All long-running automation should write structured
logs and final notifications that include enough identifiers to trace the run:
project id, task kind, run id, PR URL when present, result status, verification,
and report path.

## Current Config Shape

The live Loop Engineering config is stored outside the repository, typically at:

```bash
~/.tmux-claude-bot/state/loop-engineering.yml
```

At the time this document was written, the active project set included:

- `geo-backend`: bug-fix, test-coverage, security-maintenance, project PR review.
- `geo-frontend`: bug-fix, test-coverage, security-maintenance, project PR review.
- `knowledge-engine`: architecture, bug-fix, test-coverage, security-maintenance,
  project PR review.
- `alcove`: architecture, bug-fix, test-coverage, security-maintenance,
  harness-auto, opportunity-discovery, project PR review.
- `tmux-claude-bot`: architecture, bug-fix, security-maintenance, project PR
  review.
- `geo` workspace: coordinated backend/frontend architecture.
- repository-wide PR review: geo-backend, geo-frontend, knowledge-engine,
  alcove, tmux-claude-bot, mesh-talk, and net-auto-switch.

Treat this list as an example snapshot, not the source of truth. Validate the
live config with:

```bash
tcb loop validate ~/.tmux-claude-bot/state/loop-engineering.yml --json
```

## Maintenance Checklist

When changing intelligent automation behavior, update all relevant surfaces:

- WorkOrder generation and supervisor prompt policy
- system gates and retry/revision behavior
- task discovery and daily audit expectations
- Telegram and Feishu/Lark command/card/callback parity
- TUI/CLI commands when applicable
- `docs/manual.md`, `docs/agents/usage-guide.md`, and this document
- `AGENTS.md` when the change is a rule future coding agents must obey
- tests covering config parsing, scheduling, work-order text, notification
  actions, and recovery behavior

Avoid adding direct model-provider SDKs or API-key paths for bot-owned AI
behavior. AI-backed work must route through the existing Claude/Codex agent
sessions and control surface.
