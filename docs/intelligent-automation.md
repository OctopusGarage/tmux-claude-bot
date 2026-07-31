# Intelligent Automation

This document is the maintenance map for tmux-claude-bot's intelligent
automation features. It defines the names, ownership boundaries, execution flow,
and configuration relationships so future changes do not blur Loop Engineering,
Loop Supervisor, Autopilot, Opportunity Discovery, PR review, Daily Task Audit,
or Runtime Guardian.

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
        +-- Loop Supervisor sessions: reserved Claude/Codex orchestrators for WorkOrders
        +-- Loop worker sessions: reserved target-project execution panes
        +-- system gates: output, git, PR, CI, mergeability, switch-back checks
        +-- state/logs/ledger: run reports, task audit evidence, notifications
```

The bot is the coordinator and final gatekeeper. Agents may reason and adapt,
but system-level code still verifies required outputs, worktree state, PR status,
CI, mergeability, notification delivery, and branch switch-back.

## Module Map

Intelligent automation is one supervised platform, not a collection of unrelated
agent features. New behavior should fit into this map unless there is a documented
reason to add a new module.

```text
Ingress surfaces
  Telegram / Feishu / TUI / CLI / scheduler tick
        |
        v
Intent modules
  Loop Engineering        scheduled project/workspace health work
  Autopilot               owner-confirmed active delegation
  Opportunity Discovery   read-only proposals before owner approval
  PR Review               loop-created or repository-wide PR review/merge
  Daily Task Audit        retrospective schedule audit and self-repair
  Runtime Guardian        near-real-time runtime artifact self-healing
        |
        v
Execution contract
  WorkOrder               bounded task, policy, paths, final marker, artifacts
        |
        v
Orchestration
  Loop Supervisor         agent-backed orchestration, retries, revision prompts
  Loop worker             isolated target-project execution context
        |
        v
System acceptance
  system-gate.json        output, git, PR, CI, mergeability, branch, notification
        |
        v
Evidence and feedback
  ledger / logs / reports / notifications / audit repair / runtime guardian
```

The interface between these modules is deliberately narrow: intent modules
materialize a WorkOrder; the supervisor executes it; the system gate accepts or
rejects it; ledger/log/notification artifacts explain the result. Avoid adding
feature-specific completion rules outside this path.

## Design Rules For New Automation

Use these rules when adding a task family, button, command, scheduled flow, or
repair path:

- Prefer a new WorkOrder task kind or WorkOrder policy over a side-channel prompt
  into a project chat.
- Reuse the existing supervisor pool, worker isolation, conflict planner,
  system-gate artifact, task ledger, and notification gateway.
- Keep AI judgment agent-backed through the managed Claude/Codex sessions. Do
  not add provider SDKs, model API keys, or direct model HTTP calls.
- Pick the verification profile from risk. Read-only/no-op work can use smoke or
  focused checks; narrow code edits need focused regression and affected local
  verification; full verification is required when the change touches shared
  contracts, CI gates, security boundaries, or release-critical behavior.
- Record the selected verification profile and any skipped stronger gate in the
  final summary. A skipped full suite is acceptable only when the recorded
  evidence explains why it was not necessary or was blocked.
- Treat notification delivery as part of the result, not cosmetic output. A task
  whose owner-facing result could not be delivered must leave auditable delivery
  evidence for Daily Task Audit.
- Keep project/workspace paths authoritative. Validate git toplevel before
  mutating commands, and never infer the target repository from the current shell.
- Add conflict tests when a task can edit a worktree, branch, PR, or shared
  runtime artifact. The test should prove what runs, what skips, and what waits.
- Document any intentional channel difference between Telegram and Feishu/Lark.
  The goal is capability parity, not identical card layouts.

If a proposed feature cannot follow these rules, write down which module owns the
exception, what evidence gates it uses instead, and how Daily Task Audit can
diagnose it later.

## Execution Isolation

Long-running automation must isolate execution context while keeping management
centralized.

- Ordinary user chat stays in the project-bound session. Scheduled jobs,
  Autopilot delegation, PR review, harness-auto, Daily Task Audit repair, and
  other bounded WorkOrders must not be injected into that ordinary chat context.
- Every WorkOrder carries the authoritative `projectId`, `projectPath`, and
  execution-isolation contract. The configured path is the only trusted source
  for selecting a target repository.
- Before sync, assessment, edits, PR review, or any mutating shell command, the
  supervisor or worker must verify `git -C <projectPath> rev-parse --show-toplevel`
  matches the configured path. Workspace WorkOrders must perform the same check
  for every repository they touch.
- A dedicated supervised worker context should be leased per WorkOrder or per
  bounded run slice. It must use the reserved session name shape
  `<projectSessionPrefix>loop-worker-*`; `open-worker` must not create ordinary
  project sessions. Reset the worker with the configured `compact` or `clear`
  policy before substantive work and between unrelated subtasks.
- The Loop Supervisor owns orchestration, revision prompts, final summary
  validation, and system-gate retry. Worker sessions perform the bounded target
  work; they are not the final acceptance authority.
- On successful system acceptance, release the worker. On failure, timeout,
  cancellation, or invalid output, retain the worker transcript for the
  configured TTL so the run can be inspected, then allow cleanup.
- Active and retained worker leases are persisted under the state directory as
  `loop-supervisor-worker-leases.json`; this file is an operational artifact,
  not source configuration.
- Expired retained leases are consumed before a supervisor worker is ensured:
  the old tmux session is killed best-effort, the lease is removed, and the
  normal supervisor startup path recreates the worker when it is still needed.
- Long-idle loop worker sessions are reclaimed by the session idle reaper. Unlike
  ordinary project sessions, a reclaimed loop worker has its whole tmux session
  killed because it is automation infrastructure, not a human chat context.
- Persist enough artifact data to replay the run without reopening the worker:
  leased worker/session name, expected path, actual git toplevel, reset action,
  cleanup decision, PR/check state, verification commands, and final summary.

Lifecycle matrix:

| Session kind | Name shape | Visible in project pickers | Work source | Cleanup |
| --- | --- | --- | --- | --- |
| Ordinary project | `<projectSessionPrefix><path>` or free slot | Yes | Human chat, TUI, direct CLI | Idle reaper exits the agent, preserving the tmux session context. |
| Loop Supervisor | `<projectSessionPrefix>loop-supervisor[-N]` | No | WorkOrder orchestration | Supervisor lease/retained TTL cleanup. |
| Loop worker | `<projectSessionPrefix>loop-worker-*` | No | Target-project delegated execution | Idle reaper kills the tmux session after the idle threshold; retained failure transcripts are controlled by WorkOrder artifacts and leases. |

## Terms

| Term | Meaning | Not This |
| --- | --- | --- |
| Project agent | The Claude/Codex session attached to one target repository. | The final authority for PR/CI gates. |
| Loop Engineering | Scheduled project/workspace health platform. | One-off user delegation. |
| Loop Supervisor | Reserved Claude/Codex worker that executes bounded WorkOrders. | A replacement for system gates. |
| WorkOrder | The strict task contract passed to a supervisor. | An open-ended chat prompt. |
| Autopilot | Active delegation of a user-confirmed current task to Loop Supervisor. | Keep-alive, cron, goal-cycle, goal-picker, or global keepalive UI. |
| Opportunity Discovery | Read-only suggestion generation before owner approval. | Implementation or PR creation. |
| Daily Task Audit | Bot-owned scheduled task audit and auto-repair loop. | General project health maintenance. |
| Runtime Guardian | Near-real-time watcher for bot-owned runtime artifacts that can delegate tmux-claude-bot self-repair. | Target-project maintenance or a replacement for system gates. |
| `pullRequestReview` | Project/workspace loop-created PR review. | Repository-wide open PR processing. |
| `prReview.repositories` | Repository-wide all-open-PR queue processing. | Only loop-created PRs. |
| Batch Scheduler | Generic batch plan scheduler controlled by `BATCH_SCHEDULER_*`. | Autopilot. |

Legacy Autopilot keep-alive and goal-cycle code has been removed. New
user-facing delegation buttons, commands, opportunity handoffs, or scheduled
flows must route through Supervisor-backed WorkOrders. Batch scheduling uses
`BATCH_SCHEDULER_*` and must not use `AUTOPILOT_SCHEDULER_*` aliases.

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
  -> lease isolated supervised worker context
  -> verify configured projectPath / workspace repository paths
  -> supervisor analyzes, verifies, edits, and reports through the worker
  -> write strict final summary JSON
  -> system gate validates marker, summary, git state, PR, CI, mergeability
  -> recoverable failures are sent back to the same supervisor
  -> final PR merge or report-only completion
  -> switch back to configured base branch
  -> fast-forward local base branch
  -> release successful worker or retain failed worker transcript until TTL
  -> write logs, ledger, reports, notifications
```

The supervisor must not be detached just because it printed something that looks
done. The system gate owns completion. If the summary is malformed, PR checks are
pending, the worktree is dirty, the branch is wrong, or the PR body needs cleanup,
the bot should send a bounded revision prompt and re-run the gate. Non-recoverable
platform failures, such as missing GitHub permission, should fail with a concrete
blocker.

Every supervised run must persist system gate evidence beside the supervisor
report as `system-gate.json`. This artifact records whether the gate accepted the
run, which checks justified acceptance, which failures blocked acceptance, and
which failures were recoverable. Daily Task Audit and human debugging should
prefer this artifact over a stale `supervisor-final-summary.json` when they
disagree.

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

`harnessAuto` is a containing task. When it is active or due for the same
resource and has an enabled subtask for architecture, bug-fix, test-coverage, or
security-maintenance, the overlapping standalone task should skip or wait instead
of creating a second branch or PR. This is a conflict rule, not a prompt
preference.

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

Repository-wide PR review may repair only small, deterministic failures on
same-repository PR branches. It should not edit fork PRs, drafts, merge-conflict
branches, broad refactors, migrations requiring product judgment, or security
changes whose severity/reachability is unclear. Those should remain blocked with
evidence.

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

Daily Task Audit should flag "successful" loop artifacts when durable evidence
contradicts success. Examples include a completed supervisor final summary whose
`finalVerification` is not `passed`, risky unresolved follow-up text, or a
`system-gate.json` artifact with `accepted=false`. Harmless follow-up reminders
are not repair candidates by themselves.

Notification delivery results are audit evidence. Failed or partial deliveries
should preserve the channel, error, whether the main message was sent, and the
failed stage (`message`, `attachment`, validation, or missing sender), so repair
work can distinguish "nothing reached the owner" from "the message arrived but
an attachment failed."

## Runtime Guardian

Runtime Guardian is the running-service guardrail for problems that appear while
Loop Supervisor, workers, PR gates, notifications, launchd/dev-service runtime,
or task-audit evidence are active. It complements Daily Task Audit:

- Daily Task Audit is scheduled retrospective checking.
- Runtime Guardian is near-real-time runtime artifact checking.

`RUNTIME_GUARDIAN_MODE=fast-heal` delegates a bounded self-repair WorkOrder
through the existing Loop Supervisor when it finds confirmed system evidence,
such as a terminal WorkOrder missing `system-gate.json`, a terminal
`invalid-output` state, or an active worker lease still attached to a terminal
WorkOrder. `observe` records the finding without repair delegation.
By default it only considers terminal artifacts updated within
`RUNTIME_GUARDIAN_LOOKBACK_MS` so enabling it does not replay historical
pre-guardian backlog as fresh runtime incidents.

Runtime Guardian must keep these boundaries:

- It repairs tmux-claude-bot orchestration/runtime code only.
- It must not edit target project repositories mentioned by failing WorkOrders.
- It must re-check evidence before editing, fix narrowly, add focused regression
  coverage when practical, run verification, inspect the diff, and commit only a
  verified fix.
- It must not dispatch self-repair while the tmux-claude-bot repository has
  uncommitted changes; those runs should wait for a clean worktree.
- It must use the same active delegated task path as Autopilot and Daily Task
  Audit repair, so supervisor pool limits, worker isolation, system gates, PR
  policy, and merge policy stay centralized.
- It should record structured logs for each tick: mode, finding kind, projectId,
  runId, runDir when available, dispatch status, and blocker details.

## Conflict Rules

Automation should remain serialized where work can collide:

- One project should not run multiple code-editing jobs against the same worktree
  at the same time.
- User-originated ordinary chat/control prompts must not be injected into a
  project agent while that project has an unfinished or recoverable Loop
  Supervisor WorkOrder. System-originated supervisor prompts may continue because
  they are the owner of that automation. Status, peek, interrupt, cancel, and
  other diagnostic/escape controls should stay available.
- `harnessAuto` contains architecture, bug-fix, test-coverage, and security
  maintenance. When a harness run is active or due, overlapping standalone jobs
  should skip or wait rather than create duplicate PRs.
- PR review should not repair a branch while the originating task still owns it.
- Opportunity Discovery is read-only, but discussion or delegation should block
  when the target project has active automation, queued/in-flight user work, or a
  dirty worktree.
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
- conflict planner behavior and tests for overlapping worktrees, workspace jobs,
  harness-contained subtasks, PR repair, and user-originated prompts
- verification profile selection and final-summary evidence
- runtime guardian and daily-audit visibility for new failure modes
- `docs/manual.md`, `docs/agents/usage-guide.md`, and this document
- `AGENTS.md` when the change is a rule future coding agents must obey
- tests covering config parsing, scheduling, work-order text, notification
  actions, and recovery behavior

Avoid adding direct model-provider SDKs or API-key paths for bot-owned AI
behavior. AI-backed work must route through the existing Claude/Codex agent
sessions and control surface.
