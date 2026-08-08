# Intelligent Automation

## Recovery state-machine guarantees

Supervisor delivery has a bounded worker-consumption watchdog. A prompt that
remains queued because the worker never becomes ready is cancelled with an
explicit retryable delivery failure; it is not left indefinitely in an
ambiguous queued state.

Supervisor concurrency and supervisor queueing are separate controls. The pool
size limits active supervisor workers, while each supervisor session has the
configured message queue capacity (30 by default). A task may wait in that
queue behind an active supervisor lease; it is only rejected when the queue is
full or the supervisor session cannot be ensured.

Project recovery is project-scoped: an existing leased or running recovery is
never duplicated, and later findings are attached as deferred work. A recovery
is closed only from an authoritative `supervisor-final-summary.json` reporting
completed with a passing decision. Queue and ledger state are reconciled
together so a successful environment repair does not remain falsely pending.
Failed Autopilot delegations for configured projects follow the same recovery
path as Loop Engineering failures; invalid or missing supervisor summaries are
retryable orchestration evidence. Capacity, active-project, or supervisor
reservation deferrals remain pending and immediately claimable, not terminal
blocked outcomes.
If any live WorkOrder already owns the project, project recovery defers without
claiming the queue record or consuming a retry attempt; admission resumes after
that WorkOrder reaches a terminal state.
Scheduled and forced Daily Audit invocations are serialized by a process-local
mutex, preventing overlapping audits from creating duplicate recovery attempts.
Closing an abandoned WorkOrder advances the scheduler checkpoint for its
occurrence, preventing an immediate duplicate dispatch; a valid delegated final
summary is authoritative even if the WorkOrder state is still `in-flight`.
Each recovery delegation is linked to its generated Autopilot task, and a
passing authoritative recovery result closes the original failed task and its
repair queue record together.
Project-recovery queue records are owned exclusively by the project-recovery
admission path; the generic Daily Audit repair dispatcher excludes them so a
completed historical recovery cannot be redispatched through a second path.
If a queue links to a missing historical ledger task but every remaining linked
outcome is terminal, reconciliation closes the queue as blocked with the
uncertainty preserved for human review instead of retrying indefinitely.
Queue records that resolve to no ledger evidence are likewise terminalized as
blocked; an agent cannot safely repair an unidentifiable task.
Repository-wide PR review has a narrower decision contract: every in-scope PR
must be recorded as `merged`, `closed`, `retry`, or `manual-review`. `retry`
remains claimable through the review queue and backoff path; `manual-review` is
the explicit human terminal state. A PR may be closed automatically only with
an evidence-backed `duplicate`, `obsolete`, `non-actionable`, or `invalid`
reason. Draft, conflict, age, pending checks, and ordinary repair failures are
not close reasons by themselves.
An open project-recovery lease linked only to terminal WorkOrders is released
before the next admission pass when no live WorkOrder remains; an unknown live
recovery is still deferred to preserve the one-project mutation invariant.
The same linkage is required for Daily Task Audit bot-owned repairs; a failed
delegation returns the original item to `pending` immediately instead of
leaving it falsely `running`.
Stale running repair statuses are evaluated per linked WorkOrder, not globally:
an unrelated live delegation cannot block cleanup of another terminal repair.
Daily Audit reconciles those ledger and queue records before project-recovery
admission so completed or orphaned WorkOrders cannot hold a recovery lease.
When an Autopilot ledger record is linked to a terminal WorkOrder, it is
reopened immediately rather than waiting for the general stale-status timeout.
Startup reconciliation gives queued, dispatching, and in-flight WorkOrders with
an existing worker pane a bounded two-minute grace period for the agent process
to appear, preventing a normal startup race from being recorded as an orphaned
worker.
If that terminal delegation failed, the linked project-recovery lease is released
and both the original and delegated records return to pending in the same audit
pass, so the next available worker can retry without waiting for lease expiry.

Runtime Guardian does not self-repair target-project or external blockers. Dirty
target worktrees, branch-policy conflicts, GitHub permission failures, and
network/TLS failures are terminalized as blocked; stale invalid-output records
are reconciled from later gate artifacts as fixed or not-reproducible. Only
confirmed bot-owned runtime findings enter the bot self-repair WorkOrder.

Every terminal supervised WorkOrder also has a cleanup closure. Successful runs
release the worker and immediately remove their bot-owned isolated execution
worktree. Failed, timed-out, cancelled, and invalid-output runs retain the worker
for the configured inspection TTL, then the next service reconciliation removes
the isolated worktree and releases the lease. Source worktrees are never removed;
the cleanup helper verifies both the state-owned path boundary and Git toplevel
before issuing `git worktree remove --force`.

## State And Outcome Vocabulary

The task ledger and Repair Coordinator use different layers of state. A task
with `status=failed`, `missing`, or `running-timeout` is an observed execution
problem; its `repairStatus` describes whether recovery is still open. A queue
record with `pending`, `leased`, `running`, or `retry-wait` is still in progress
and must not be reported as resolved. `retry-wait` means the bounded backoff has
not expired yet; once `nextAttemptAt` is due, the record is immediately eligible
for the next available repair worker.

Terminal repair outcomes are `fixed`, `blocked`, `not-reproducible`,
`superseded`, and `dead-letter` for queue records. Ledger repair outcomes also
include `not-needed` and `failed`: `not-needed` is a successful no-op, while
`failed` remains open for classification or retry. `blocked` is reserved for a
proven safety, ownership, configuration, or external dependency boundary; it is
not a synonym for queue capacity or a temporary worker shortage. `superseded`
means a newer or higher-priority linked repair owns the same task, and
`not-reproducible` means the original evidence could not be reproduced after
the prescribed verification. Daily Audit and Runtime Guardian must reconcile
these outcomes with the linked ledger task ids before declaring a repair clean.

Repository PR review queue records additionally expose `manual-review` as a
terminal status distinct from retryable `retry-wait`. The queue may complete
only after all structured PR decisions are terminal (`merged` or allowlisted
`closed`), or retain the item as `manual-review` when every unresolved decision
explicitly requires an owner at a concrete ownership, permission, product,
migration, security-design, legal, or compliance boundary. Generic architecture
or design review, diff size, Draft state, merge conflicts, and ordinary code
repair are not human boundaries: the contract downgrades those claims to
`retry`, returning the item to the shared repair queue. Missing or malformed PR
decisions are orchestration failures and return to retry, never to a false
completed state.

Security Maintenance assessments use the same deterministic contract everywhere:
the configured command must emit a JSON object with numeric `riskScore` from
0–100. Optional `critical: true` or `severity: "critical"` forces dispatch;
optional string arrays `findings` and `suggestedBotImprovements` are retained as
assessment notes. Non-zero exit status, invalid JSON, or a missing numeric
`riskScore` blocks dispatch without repository mutation. The default action and
critical thresholds are 70 and 90, respectively.

This document is the maintenance map for tmux-claude-bot's intelligent
automation features. It defines the names, ownership boundaries, execution flow,
and configuration relationships so future changes do not blur Loop Engineering,
Loop Supervisor, Autopilot, Opportunity Discovery, PR review, Daily Task Audit,
or Runtime Guardian.

For the end-to-end architecture view, see
`docs/intelligent-automation-architecture.md`. For command-level usage, see
`docs/manual.md`, `docs/commands.md`, and `docs/agents/usage-guide.md`. For
the governed system prompt inventory, allowed-action scope, and prompt eval
rules, see `docs/prompt-governance.md`. For role-based AI-facing CLI, MCP, and
skill exposure, see `docs/ai-tool-surface-governance.md`.

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
  Repair Coordinator      durable repair queue, dedupe, leases, retry, recovery
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

Daily Task Audit and Runtime Guardian are repair producers, not independent
repair schedulers. They enqueue logical repair findings into the shared Repair
Coordinator. The Coordinator imports historical unresolved ledger records only
when they are owned by the bot project, using an exact task-family boundary
instead of a substring match; configured project records remain under project
recovery ownership. It deduplicates findings, enforces one mutating WorkOrder per project, owns lease
expiry and retry backoff, and reconciles each linked task into a terminal or
retryable repair status. This is the only service-owned consumer of durable
repair backlog state; manual force-triggering is an operator diagnostic, not a
required recovery path.
On process startup, queued or dispatching Autopilot WorkOrders are reattached
to the current background executor when no active worker lease exists. Active
leases are checked against the WorkOrder's actual isolated worker session and
agent; an active supervisor-pool lease without that worker is recorded as a
bounded invalid-output failure, released, and handed back to project recovery.
A service restart or machine reboot must therefore preserve live delegations,
and automatically requeue delegations whose worker disappeared, instead of
leaving a WorkOrder permanently queued or falsely treating the pool session as
the worker.
Terminal ledger invariants are enforced during every audit tick: successful or
skipped tasks always carry `repairStatus=not-needed`, while failed tasks retain
their explicit repair outcome.

## Native Agent Capability Boundary

tmux-claude-bot should not implement its own heavy multi-agent orchestration
layer inside the service. The service owns task boundaries, execution isolation,
prompt policy, durable artifacts, and system acceptance. The active Claude Code
or Codex worker owns the actual reasoning strategy, including any native
subagent, parallel exploration, planning, or evaluation capability that the
agent surface supports.

Do not model researcher, evaluator, planner, or implementation subagents as
bot-managed task types, queues, leases, or lifecycle state unless there is a
separate product requirement and an enforced system contract. Prefer governed
prompt guidance that tells the worker when broad exploration, independent review,
or evidence synthesis is useful, then require the worker to summarize the result
in the WorkOrder final summary and handoff artifacts.

This boundary does not forbid repo-owned evaluation contracts, schemas, reports,
or deterministic gates. An eval module may standardize task outcomes, grader
results, trace references, and `reviewGate` evidence, but it must not imply a
separate evaluator runtime, session, task queue, or service role. Evaluation
execution stays worker-internal unless the service must own authorization,
cross-run state, recovery, or deterministic acceptance.

The intended split is:

```text
tmux-claude-bot = task boundary + isolation + prompt policy + artifacts + system gate
worker agent = reasoning strategy + optional native subagents + implementation + self-review
```

This keeps the platform thin enough to benefit from improvements in the
underlying agent products. The bot should not duplicate native agent capability
with a second scheduler unless the work needs service-level state, cross-run
recovery, authorization, or deterministic acceptance that prompt guidance cannot
provide.

## Task Family Agent Methodology

When adding or revising a WorkOrder task family, design the task as a bounded
system contract plus a professional worker prompt. Do not start by asking how
many bot-managed agents, sessions, or queues the platform should create. Start
by deciding what the active worker should investigate, what evidence it must
return, what it may change, and what deterministic gates will accept the result.

Use this formula as prompt-design guidance:

```text
Task family = service-owned boundary + worker-owned exploration + final evidence synthesis
```

The multi-agent value described in agent literature maps to tmux-claude-bot as
worker-internal capability unless a product requirement proves otherwise:

- Parallel exploration: useful for open research, large codebase investigation,
  comparing candidate fixes, workspace contracts, security surfaces, coverage
  gaps, and opportunity discovery. Encode it as "use native exploration when
  useful", then require compressed conclusions.
- Context isolation: useful when each direction has enough detail to pollute the
  main prompt. Let the active worker use native subagents or equivalent context
  tools when available, but require the WorkOrder final summary and handoff
  artifacts to carry only synthesized evidence.
- Role separation: useful for planner, researcher, implementer, and evaluator
  perspectives. Express those as prompt roles or review passes inside the
  worker, not as tmux-claude-bot service roles.
- External feedback: useful for UI/product experience, PR review, security,
  migrations, and long task implementation. Encode it as a required review pass,
  rubric, deterministic gate, real-environment check, or `reviewGate` evidence.
  For complex, UI/product-experience, PR-review, security, workspace,
  harness-auto, or long delegated tasks, the final summary should use
  `reviewGate.evidence` for synthesized evaluator-style findings instead of
  creating a bot-managed Evaluator role.

A task family is a good candidate for native multi-perspective worker guidance
only when all of these are true:

- Independent directions can be explored without editing the same state.
- The result can be verified through tests, static checks, PR/CI state, logs,
  reports, user paths, or other durable evidence.
- The worker can synthesize conflicting findings into a small decision set.
- The cost of exploration is justified by risk, ambiguity, codebase size, or
  expected value.

Keep the task simple and mostly serial when the work is small, strictly
sequential, has shared mutable state, lacks objective success criteria, or would
spend more effort coordinating than solving. In those cases, the prompt should
tell the worker to do one focused pass, verify it, and stop.

Every task-family prompt that encourages broad exploration or role separation
should also require structured synthesis. The worker may use any native child
agent format internally, but the persisted result should answer:

```text
Question investigated:
Conclusion:
Evidence:
- ...
Uncertainty:
Recommended next step:
```

This evidence format is a reporting discipline, not a new WorkOrder schema by
default. Add schema fields only when downstream code, Daily Task Audit, Runtime
Guardian, reports, or system gates need to consume the structure mechanically.
The supervisor's critical skill is synthesis and acceptance, not reading every
raw transcript from worker-internal exploration.

## Agentic Coding Work Loop

Claude Code and Codex are agentic coding environments, not chat boxes. A good
WorkOrder gives the active worker a verifiable, correctable, and replayable
environment. Every code-changing task family should inherit this loop:

```text
Explore -> Plan -> Code -> Verify -> Review -> Record
```

- Explore: inspect relevant source, tests, error output, logs, run reports,
  ledger records, prior handoff artifacts, `system-gate.json`, and project
  constraints before editing.
- Plan: define the smallest coherent slice, expected behavior, risk, validation
  commands, and stop conditions. Complex or owner-delegated tasks should record
  this in the delegation brief, planning contract, `actionsTaken`, or
  `reviewGate.notes`.
- Code: make the minimum bounded change needed for the verified goal. Avoid
  broad rewrites, unrelated cleanup, dependency churn, and speculative product
  scope.
- Verify: run deterministic checks appropriate to risk, such as reproduction
  commands, tests, typecheck, lint, coverage, browser/E2E, PR/CI, mergeability,
  or the narrowest available local verification.
- Review: inspect the resulting behavior, diff, boundaries, regressions,
  over-engineering, security, data, migration, deployment, and user-visible
  risks before finalizing.
- Record: preserve what happened in durable artifacts. A failure should say
  whether it should become a regression test, eval, monitor, trace, checklist,
  documentation update, Daily Task Audit signal, or Runtime Guardian finding.
  Preserve acceptance targets from the WorkOrder, task policy, and planning
  contract by marking them passed, blocked, or deferred in final summary
  evidence; do not silently narrow the target list to claim completion.

When users report that an agent or model "got worse", treat it as a system
diagnosis until evidence says otherwise. Check routing, session identity,
context history, prompt/policy changes, reasoning effort defaults, cache or
history handling, tool output processing, infrastructure failures, provider
transients, and deterministic gate evidence before blaming the model. A useful
postmortem changes the system: add a regression test or eval, improve a monitor
or trace, tighten a prompt or gate, or update the checklist that would have
caught the issue earlier.

## Transient Agent Failures

Agent-provider capacity, rate limiting, readiness, queue pressure, and network
transients are platform failures, not target-project code failures. Treat errors
such as `Selected model is at capacity. Please try a different model.` as
retryable agent transient evidence unless later system-gate evidence proves a
project problem.

Responsibility is layered:

- Loop Supervisor runner owns short, bounded retries for provider transients
  while executing a supervisor prompt. It must not loop forever or edit project
  code to "fix" provider capacity.
- Loop Service and supervisor completion own schedule recovery. If a supervisor
  dispatch ultimately fails for a retryable agent transient, the due schedule
  must remain retryable instead of being silently consumed.
- Daily Task Audit owns retrospective visibility. The ledger should classify
  model capacity/rate-limit failures explicitly so repair candidates are not
  reported as unknown project failures.
- Runtime Guardian owns near-real-time artifact gaps. A terminal supervised
  WorkOrder with dispatch-failed agent transient evidence is a bot-runtime
  finding and may delegate tmux-claude-bot repair; it must not edit the target
  project repository mentioned by the failed WorkOrder.

## Design Rules For New Automation

Use these rules when adding a task family, button, command, scheduled flow, or
repair path:

- Prefer a new WorkOrder task kind or WorkOrder policy over a side-channel prompt
  into a project chat.
- Prefer prompt-level worker guidance over service-level subagent orchestration.
  If a task benefits from parallel investigation, role-played review, or
  generator/evaluator separation, describe that expectation in the governed
  prompt and final-summary evidence contract instead of adding bot-managed
  researcher/evaluator/worker task queues.
- Register governed system prompts and task-family policy changes according to
  `docs/prompt-governance.md`; do not add code-changing, PR-changing, merge, or
  self-repair prompt behavior without metadata and deterministic contract tests.
- Register task-family behavior in the task-family governance registry before
  relying on prompt prose. The registry owns scheduling, action scope, owner
  confirmation, planning, AI/eval expectations, default isolation, and stop-rule
  facts for WorkOrder task kinds.
- Reuse the existing supervisor pool, worker isolation, conflict planner,
  system-gate artifact, task ledger, and notification gateway.
- Keep AI judgment agent-backed through the managed Claude/Codex sessions. Do
  not add provider SDKs, model API keys, or direct model HTTP calls.
- Pick the verification profile from risk. Read-only/no-op work can use smoke or
  focused checks; narrow code edits need focused regression and affected local
  verification; full verification is required when the change touches shared
  contracts, CI gates, security boundaries, or release-critical behavior.
- Treat cleanup aggressiveness as an explicit WorkOrder policy, not an implicit
  agent mood. `cleanupPolicy: conservative` is the default; it fixes only the
  confirmed issue and directly related dead code. `balanced` may remove
  unsupported stale paths when docs, commands, tests, and integrations prove
  they are not part of the supported contract. `aggressive` may actively remove
  obsolete compatibility paths, duplicate entry points, transition code, and
  stale docs after recording evidence and verification.
- Record the selected verification profile and any skipped stronger gate in the
  final summary. A skipped full suite is acceptable only when the recorded
  evidence explains why it was not necessary or was blocked.
- Treat notification delivery as part of the result, not cosmetic output. A task
  whose owner-facing result could not be delivered must leave auditable delivery
  evidence for Daily Task Audit. New recurring notification shapes should be
  represented as notification events before adapter-specific formatting.
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
- Worktree isolation is configurable per WorkOrder family and defaults to
  `isolated`. `source` mode keeps the dedicated supervisor/worker context but
  executes in the source worktree; use it only for explicit live/self-repair
  flows after clean-worktree preflight. `auto` resolves to the safe default for
  the task family, with read-only opportunity discovery allowed to avoid a
  disposable worktree.
- Every WorkOrder carries the authoritative `projectId`, `projectPath`, and
  execution-isolation contract. The configured path is the only trusted source
  for selecting a target repository.
- Before sync, assessment, edits, PR review, or any mutating shell command, the
  supervisor or worker must verify `git -C <projectPath> rev-parse --show-toplevel`
  matches the configured path. Workspace WorkOrders must perform the same check
  for every repository they touch.
- In isolated execution, the worker must stay on the WorkOrder branch and must
  not checkout, rebase, or mutate the shared base/switch-back branch or the
  original source worktree. Preparation may fetch a remote ref for the isolated
  worktree, but must never run `git switch` or `git pull --rebase` in the source
  checkout. The bot system owns source branch switch-back after acceptance; this
  prevents an isolated worker from advancing a branch ref while leaving the
  user's source worktree on an older tree.
- A dedicated supervised worker context should be leased per WorkOrder or per
  bounded run slice. It must use the reserved session name shape
  `<projectSessionPrefix>loop-worker-*`; generated WorkOrders include the run
  identity in that worker name so retained failure transcripts cannot block the
  next run for the same project. `open-worker` must not create ordinary project
  sessions. Reset the worker with the configured `compact` or `clear` policy
  before substantive work and between unrelated subtasks.
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
- Accepted completed WorkOrders clean up their loop worker tmux session
  immediately. Long-idle loop worker sessions without accepted completion
  evidence are reclaimed by the session idle reaper using
  `SESSION_IDLE_REAPER_LOOP_WORKER_MAX_IDLE_MS` (default 6 hours), separate from
  the ordinary project-agent threshold. Unlike ordinary project sessions, a
  reclaimed loop worker has its whole tmux session killed because it is
  automation infrastructure, not a human chat context.
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
  -> risk-selected preflight checks (read-only smoke work may skip dependency preflight)
  -> materialize bounded WorkOrder
  -> record planning contract when the work is agent-driven or owner-delegated
  -> assign Loop Supervisor
  -> lease isolated supervised worker context
  -> classify retryable agent/provider transients before blaming project code
  -> verify configured projectPath / workspace repository paths
  -> supervisor writes delegationBrief before substantive execution when planning is required
  -> supervisor analyzes, verifies, edits, and reports through the worker
  -> write strict final summary JSON
  -> include planReview when the WorkOrder carried planning
  -> system gate validates marker, summary, git state, PR, CI, mergeability
  -> recoverable failures are sent back to the same supervisor
  -> final PR merge or report-only completion
  -> switch back to configured base branch
  -> rebase local base branch onto origin
  -> release successful worker or retain failed worker transcript until TTL
  -> write logs, ledger, reports, handoff artifacts, notifications
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

Every supervised run must also write `handoff.json` and `handoff.md` beside the
supervisor report. These are the resumable long-task artifacts: they summarize
the WorkOrder goal, task kind, structured planning contract, acceptance criteria,
stop conditions, actions taken, commits, verification status, structured review
evidence, learning candidates, next steps, and remaining risks. Capability eval
candidates are non-blocking learning signals until stabilized; regression
candidates protect behavior already accepted as working and should become
blocking only when the evidence is deterministic or stable enough. Future
supervisors and human debuggers should use these artifacts before reopening
retained worker transcripts or guessing from chat context.

Completed supervised runs also write `eval-report.json` as a normalized view of
the final summary's worker-internal review evidence, deterministic gates,
outcome, and learning candidates. This artifact is an eval contract/report, not
an independent evaluator runtime or service role. The system gate embeds the
normalized eval report in `system-gate.json` and must reject completed runs whose
eval outcome is not `passed`. Diagnostic surfaces should preserve that chain of
evidence: `loop reports list --json` exposes the parsed eval outcome, text report
lists show the eval status, Daily Task Audit includes rejected eval outcome
details in discovered task records, and Runtime Guardian raises a finding when a
terminal completed run has persisted non-passing eval outcome evidence.

Loop run artifact names and paths are product contracts. Code that writes,
reads, indexes, or links run reports must use the loop run artifact registry
rather than hardcoded filenames so diagnostics such as report listing, task
audit discovery, Runtime Guardian, and notifications stay aligned.

## Task Families

Loop Engineering supports these project and workspace task families:

- `architecture`: improve architecture in small verified slices. It assesses a
  score first and stops when the target score is met, commonly 95, to avoid
  optimizing for its own sake. This is a hard pre-dispatch gate for both
  project Architecture and cross-repository workspace Architecture: a score at
  or above target creates no WorkOrder, while an invalid assessment blocks
  dispatch without mutating a repository.
- `bugFix`: find and fix confirmed functional, reliability, or production-risk
  bugs. It must ignore nits, style preferences, and feature requests.
- `testCoverage`: raise meaningful test coverage, commonly toward 80%. It must
  add tests for real behavior and plausible regressions, not metric-padding tests.
  If coverage work exposes a real bug, fix it narrowly and add regression
  coverage when practical.
- `securityMaintenance`: assess confirmed security risks before dispatch,
  including dependency advisories, GitHub security findings, static analysis,
  secret exposure, auth boundaries, CORS, file/path handling, command
  execution, sensitive logging, CI secrets, and supply-chain issues. Critical
  or actionable risks may run; lower-risk findings are recorded as not-needed,
  and missing or invalid evidence blocks code changes.
- `harnessAuto`: orchestrate multiple health subtasks as one run, one branch, and
  one PR. It should assess health first, select only justified enabled subtasks,
  and stop when configured health or no-confirmed-issue conditions are met.
  Its `cleanupPolicy` acts as the default cleanup stance for selected subtasks
  unless a subtask family has a more specific override. It is a prompt-guided
  worker strategy, not permission for tmux-claude-bot to start several
  bot-managed subagents or competing mutation workers for the same resource.
- `opportunityDiscovery`: inspect repository evidence and propose useful feature
  or optimization opportunities. It must not edit files, create branches, commit,
  push, or open PRs.
- `automationGovernanceReview`: review tmux-claude-bot's own automation
  governance, including task taxonomy, WorkOrder prompts, scheduler/ledger
  evidence, notification visibility, Runtime Guardian and Daily Task Audit
  boundaries, AI/eval policy, and merge discipline. It may create at most one
  repair PR only for a concrete P0/P1 governance finding and must not auto-merge
  that PR.
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

When an active delegation runs in a system-prepared isolated worktree, its base
sync fetches the configured base but keeps the worker on its configured
WorkOrder branch. It must never switch, rebase, or merge the shared base or
switch-back branch from that isolated worktree; the source worktree owns those
operations.

Before substantive execution, active delegation must form a task advancement
contract from the user requirement, current session context, and repository
evidence. The contract is recorded as a concise `delegationBrief` in the
supervisor final-summary evidence, not as a private chat-only plan. It should
include objective, current assessment, optional current and target scores when a
real scoring rubric exists, task checklist, acceptance criteria, stop
conditions, non-goals, risk review, and verification plan.

If the active agent surface supports a durable goal command, the supervisor may
create or update a goal from the `delegationBrief`, but the WorkOrder remains the
authoritative system contract. A goal command is an execution aid, not a second
source of truth.

Interactive chat surfaces expose two Autopilot handoff buttons. **Delegate now**
starts the active WorkOrder immediately for already-clear scope. **Review plan
first** shows the pre-delegation objective, checklist, acceptance criteria, stop
conditions, non-goals, risks, and verification plan, then starts the same
WorkOrder only after **Confirm delegation**. CLI and typed `/autopilot` commands
remain direct handoff paths because their requirement text is already explicit.

The delegation brief is a planning gate, not a bureaucracy gate. If the
requirement is clear and bounded, the supervisor records the brief and proceeds.
If the requirement is broad, ambiguous, high-risk, or cannot produce clear
acceptance criteria and stop conditions, the supervisor should block or ask for
owner clarification instead of guessing. The final summary must record a
`planReview` in actionsTaken or reviewGate notes: checklist completion, score
target result when applicable, stop condition result, over-optimization check,
verification result, and remaining risks.

The WorkOrder may carry a structured `planning` contract so this rule is visible
in prompt renders, logs, tests, and final-summary validation. Prompt text should
not be the only place where delegated planning, acceptance criteria, stop
conditions, and non-goals are defined.

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

Feishu/Lark suggestion cards should include enough per-item problem, value, and
approach detail to decide whether to act, with view, discuss, and dismiss
actions on each suggestion plus batch controls when suggestions are related.
Telegram should align with per-suggestion discuss/dismiss buttons while each
`callback_data` payload fits Telegram's 64-byte limit; when it cannot, the
message falls back to typed `/opportunity` commands rather than sending unsafe
callbacks.

Opportunity discussion prompts should prepare a delegation brief draft from the
stored suggestion: objective, checklist, acceptance criteria, stop conditions,
non-goals, risks, and verification plan. The draft is not permission to edit; it
exists so the owner can tighten scope before handing the confirmed work to
Autopilot.

## PR Review Modes

There are two PR review surfaces:

- `pullRequestReview` is scoped to configured project/workspace loop-created PRs.
  It answers: "Did yesterday's loop task introduce a bug, fail CI, or create an
  unsafe PR?"
- `prReview.repositories` is the repository-wide open-PR queue processor. It
  answers: "Which open PRs in this repository can be reviewed, repaired narrowly
  if needed, and merged?"

Loop Engineering targets support a consistent top-level pause switch:
`projects[]`, `workspaces[]`, and `prReview.repositories[]` all accept
`enabled`. The default is `true`; set it to `false` to pause that configured
target without deleting schedules, prompts, GitHub account bindings, or repair
policy.

Both should focus on introduced bugs, failing checks, mergeability, security,
data loss, migrations, and user-visible regressions. They should not block on
style nits. When auto-merge is enabled, both use the configured `mergeMethod`
(`squash`, `merge`, or `rebase`; default `squash`) rather than assuming one
GitHub merge mode.

Draft is a review state, not an exclusion. Every open PR must be inspected before
the review run is finalized. For a same-repository Draft, the supervisor reviews
the diff, checks, ownership, and mergeability, then either performs bounded repair
and runs `gh pr ready <number>` before merging, closes obsolete/duplicate/non-
actionable work with `gh pr close <number> --comment <reason>`, or records a
specific human decision blocker. A new loop-created PR is ready by default; it
may remain Draft only when a concrete incomplete-work or human-decision blocker
is recorded.

Same-repository conflicting PRs are also active work: take over the existing head
branch, sync the base, resolve bounded and reviewable conflicts, push, and repeat
the checks and review passes. Close obsolete conflicts with evidence. Fork PRs or
changes requiring owner permissions, product judgment, migrations, or broad
security decisions remain explicit human blockers, but they must still receive a
per-PR decision. No Draft or conflict may be silently skipped.

Repository-wide PR review uses a durable queue separate from the general Loop
tick. Cron is a discovery and reconciliation fallback: it creates one
idempotent queue item per repository review occurrence and releases the
scheduler immediately. Independent consumers lease pending items when a
supervisor is available, enforce the existing per-project conflict rule, and
reuse the normal WorkOrder, system gate, final-summary, merge, and cleanup path.
Queue states are `pending`, `leased`, `running`, `retry-wait`, `completed`, and
`blocked`; expired leases return to `pending`, transient supervisor failures use
bounded backoff, and a service restart does not lose an uncompleted review.
Before a repository-review WorkOrder enters `dispatching`, it must hold the
matching active supervisor-worker lease. Recovery may mark a queue occurrence
`running` only when that same lease remains active; an unleased dispatch
reservation is not evidence of execution and remains eligible for the normal
stale-dispatch recovery path.
Supervisor capacity and project-conflict planning must include active worker
leases even when their WorkOrder artifact has already become terminal, so no
new review can select a supervisor that is still executing another task.
This prevents an unrelated long WorkOrder from starving repository PR review.

## Daily Task Audit And Auto Repair

Daily Task Audit is the bot's self-check and self-healing schedule audit. It
discovers tmux-claude-bot-owned launchd/service and Loop Engineering tasks,
merges that expected set with the shared task ledger, sends a final Telegram /
Feishu summary, and can dispatch supervisor repair when
`TASK_AUDIT_AUTO_REPAIR=true`.
Autopilot active delegations are registered in the same ledger at queue/start
and completion. Each Daily Task Audit tick reconciles terminal supervisor
artifacts back into that ledger before auditing, so a crashed completion path
cannot leave an Autopilot delegation permanently marked `running`.

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

Historical Loop failures use project-scoped recovery. The recovery classifier
reads ledger evidence and supervisor artifacts, resolves only projects,
repository-review targets, and workspaces present in the active Loop config, and
recreates safe retryable work through that target's existing branch, worktree,
agent, and verification policy. Transient environment or orchestration failures
are retried with bounded backoff and one recovery WorkOrder per project. CI,
billing, network, and runner failures wait for external recovery; draft PRs,
merge conflicts, design decisions, ambiguous ownership, and exhausted retries
remain blocked for an owner. Unconfigured repositories are never guessed or
edited by this bot. Recovery outcomes are persisted in the shared Repair
Coordinator queue and reconciled back to every original ledger task id.

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
such as a terminal WorkOrder missing `system-gate.json`, a terminal WorkOrder
whose `system-gate.json` records `accepted=false`, a terminal `invalid-output`
state, an active worker lease still attached to a terminal WorkOrder, or a
read-only smoke active delegation blocked by target dependency preflight because
isolated worktrees do not carry ignored dependency directories.
`observe` records the finding without repair delegation.
By default it only considers terminal artifacts updated within
`RUNTIME_GUARDIAN_LOOKBACK_MS` so enabling it does not replay historical
pre-guardian backlog as fresh runtime incidents.
`RUNTIME_GUARDIAN_WORKTREE_ISOLATION=auto` resolves `fast-heal` repairs to
source-worktree execution so managed-dev self-repair can take effect quickly; set
it to `isolated` for PR-style conservative repair.
Every Guardian tick also runs the same idempotent Autopilot terminal-artifact
reconciliation. A recovered final summary is accepted only with a durable
`system-gate.json`; otherwise the incident remains visible for repair, and
terminal worker session records are cleaned up when the worker is no longer
active.
Loop Engineering reconciliation also converts stale non-terminal WorkOrders
whose worker lease has disappeared into a durable failed/pending record. A
`dispatching` reservation without a lease is considered abandoned after five
minutes, while leased or in-flight work keeps the longer unfinished-work-order
timeout. Runtime Guardian reports bot-owned stale dispatch reservations as
repairable runtime findings; Loop Engineering remains authoritative for the
state transition and never runs target-project commands during this recovery.
When a configured project recovery is safe to retry but no worker or supervisor
capacity is available, the Repair Coordinator keeps it `pending` with an
immediate eligibility time. The next recovery pass can claim it as soon as
capacity is available; it does not wait for the original task's cron schedule.
On restart, the supervisor pool also reconciles the interactive panes themselves:
dedicated panes without a live WorkOrder are interrupted before dispatch resumes.
This closes the gap where a terminal WorkOrder had released its durable lease
but its provider process was still consuming the old prompt.
The same reconciliation applies to pending duplicate queue records: once all
linked task outcomes are terminal, the record is closed rather than becoming a
new repair attempt on the next audit.

Runtime Guardian must keep these boundaries:

- It repairs tmux-claude-bot orchestration/runtime code only.
- It must not edit target project repositories mentioned by failing WorkOrders.
- If a target project dependency preflight blocks a read-only smoke validation,
  it should repair tmux-claude-bot's verification profile or WorkOrder policy,
  not install dependencies in the target project.
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
 - Repository-wide PR review may repair bounded, reviewable failures on
   same-repository PR branches. Drafts and conflicts are active review states:
   each must be made ready, merged, closed with evidence, or left with a
   specific human blocker. Fork PRs and changes needing product/security design
   judgment remain human-owned, but must not be silently skipped.

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

Do not copy the active project list into repository documentation. Project names,
repository paths, GitHub accounts, schedules, and cleanup policies are user
configuration and belong in the live config file, backups of that file, or
operator notes outside the source tree. Validate the live config with:

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
