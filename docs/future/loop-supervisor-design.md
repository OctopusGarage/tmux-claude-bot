# Loop Supervisor Design

Status: design proposal. This document defines the intended shape before
implementation.

## Objective

Loop Engineering currently supports deterministic scheduled runs: a project
becomes due, the bot runs the configured command/agent pipeline, writes a report,
and stops. That is predictable, but it means a failed scheduled task often ends
without adaptive follow-up.

Loop Supervisor adds an agent-supervised runner for scheduled engineering work.
When a configured project is due, the bot creates a bounded work order and sends
it to a dedicated supervisor agent session. The supervisor can inspect the
current state, diagnose failures, delegate work to project sessions, retry
allowed recovery steps, and produce a final report.

The goal is not to add a model-provider client. All AI reasoning must happen
through the existing Claude Code / Codex agent sessions managed by this bot.

## Non-Goals

- Do not replace Loop Engineering's deterministic runner.
- Do not replace Batch Scheduler or Autopilot.
- Do not reuse the human-facing `/home` operator session for background work.
- Do not add direct OpenAI, Anthropic, Gemini, or other model-provider API calls.
- Do not build a generic arbitrary shell action executor in the first version.
- Do not run multiple work orders in the same supervisor context concurrently.

## Existing Responsibilities

### Home Operator

`/home` switches a chat channel to the human-facing operator session. The home
operator is a manual control surface. It is useful for fleet-level conversation,
but it should not receive background scheduled work because user dialogue and
automated recovery would pollute the same context.

### Batch Scheduler

Batch Scheduler owns multi-project plan scheduling, pool limits, quota pauses,
task retries, and task status. It drives project sessions through Autopilot goal
cycles. It is the right place for simple scheduled goal batches.

### Autopilot

Autopilot owns a single session's observe -> decide -> nudge loop, goal phases,
sentinels, human gates, usage gates, and wall-clock budgets.

### Loop Engineering

Loop Engineering owns engineering-maintenance policy: project config, skills,
preflight, assessment, execution, verification, eval, commit policy, reports,
and backlog suggestions.

### Skills Registry

`src/core/skills` owns shared skill metadata, remote skill catalog refresh, pinned
approved skill specs, and delegated skill sync.

## Proposed Model

Add a new Loop runner kind:

```yaml
runner:
  kind: agent-supervised
```

The existing behavior remains the default:

```yaml
runner:
  kind: system
```

System runner:

```text
preflight -> assessment -> execution -> verification -> eval -> report
```

Agent-supervised runner:

```text
schedule due
  -> build WorkOrder
  -> dispatch to loop-supervisor session
  -> supervisor observes, decides, delegates, and retries within bounds
  -> final marker + JSON summary
  -> report / backlog / notification
```

## Supervisor Session

The supervisor is a reserved tmux project-family session, separate from `/home`.

Suggested identity:

```text
session: <projectSessionPrefix>loop-supervisor
dir: <state-dir>/loop-supervisor
agent: codex | claude
```

It should be provisioned similarly to the home operator:

- create the supervisor directory under the state dir by default;
- write an idempotent `AGENTS.md` or `CLAUDE.md` with supervisor rules;
- start the configured agent with non-interactive permissions;
- exclude the supervisor from project pickers, recovery rosters, Autopilot global
  keep-alive, and normal `tcb send <project>` routing.

The supervisor drives other sessions; it must not send work to itself.

## Configuration Shape

Implementation note: the first shipped surface uses environment variables for the
global supervisor (`LOOP_SUPERVISOR_ENABLED`, `LOOP_SUPERVISOR_AGENT`,
`LOOP_SUPERVISOR_DIR`) and project-level `runner.kind` in the Loop YAML. The
supervisor session name is derived from `PROJECT_SESSION_PREFIX` as
`<prefix>loop-supervisor`.

Global Loop Supervisor config can live beside Loop Engineering config:

```yaml
supervisor:
  enabled: true
  agent: codex
  sessionName: loop-supervisor
  dir: "" # blank -> <state-dir>/loop-supervisor
  maxConcurrentWorkOrders: 1
  defaultTimeoutMs: 7200000
  defaultMaxTurns: 20
```

Project config adds a runner section:

```yaml
projects:
  - id: datavibe-backend
    name: Datavibe Backend
    path: /path/to/datavibe-backend
    agent: codex
    schedule: "30 5 * * *"
    runner:
      kind: agent-supervised
      timeoutMs: 7200000
      maxTurns: 20
      requireConfirmation: false
    goal: >
      Use improve-codebase-architecture for up to 3 rounds.
      Keep changes small, verified, and committed per round.
    maxRounds: 3
    assessment:
      command: ".venv/bin/ruff check . && .venv/bin/pyright && .venv/bin/pytest -q"
    execution:
      agent: true
    recovery:
      agent: true
      dirtyWorktree: true
      maxAttempts: 2
    commit:
      enabled: true
      perRound: true
      branch: loop/datavibe-backend/architecture
```

Cron semantics should remain whatever Loop Engineering currently documents until
timezone support is added deliberately.

## Work Order

A WorkOrder is the contract sent to the supervisor session. It must be explicit
enough that the supervisor can adapt without inventing policy.

Fields:

- `id`
- `scheduledAt`
- `projectId`
- `projectName`
- `projectPath`
- `agent`
- `goal`
- `maxRounds`
- `targetScore`
- `allowedActions`
- `blockedActions`
- `skills.approved`
- `preflight`
- `assessment`
- `verification/eval`
- `commitPolicy`
- `recentReports`
- `backlogContext`
- `dashboardContext`
- `requiredFinalMarker`

Prompt skeleton:

```text
You are the Loop Supervisor for tmux-claude-bot.

WorkOrder:
<structured JSON or YAML>

Available operating surface:
- tcb dashboard --json
- tcb open <project>
- tcb peek <project>
- tcb send <project> "<task>"
- tcb loop run <config> <projectId>
- tcb notify ...

Rules:
- Do not call model-provider APIs.
- Do not send work to the supervisor session itself.
- Diagnose failures before giving up.
- Keep project changes small, verified, and inside allowed actions.
- Do not perform destructive actions unless the work order explicitly allows it.
- Finish with the exact final marker and a JSON summary.
```

## Completion Protocol

The supervisor must finish with:

```text
[LOOP_SUPERVISOR_DONE:<workOrderId>]
```

The final response should also contain a machine-readable summary:

```json
{
  "status": "completed",
  "projectId": "datavibe-backend",
  "actionsTaken": [
    "opened project session",
    "sent architecture task to project agent",
    "reran verification"
  ],
  "delegatedTasks": [
    {
      "projectId": "datavibe-backend",
      "status": "completed"
    }
  ],
  "finalVerification": "passed",
  "commits": [],
  "followUps": []
}
```

Allowed final statuses:

- `completed`
- `failed`
- `blocked`
- `timeout`
- `cancelled`

## State Machine

System-owned work order state:

```text
queued
  -> dispatched
  -> running
  -> completed
  -> failed
  -> timeout
  -> cancelled
```

The bot does not need to understand every internal supervisor decision in the
first version. It only needs to persist the work order, observe dispatch result,
wait for the final marker or timeout, and write a report.

## Failure Handling

The supervisor should classify failures before deciding what to do:

- environment missing or stale;
- project session not running;
- wrong live agent kind;
- dirty worktree;
- deterministic verification failure;
- agent failed to finish;
- quota or usage limit;
- machine load issue;
- unsafe or too-broad requested change.

Possible responses:

- repair environment if allowed;
- open or resume the project session;
- delegate a smaller prompt to the project agent;
- rerun deterministic checks;
- mark blocked with a concrete reason;
- notify the owner;
- stop without retrying when the policy forbids recovery.

## Safety Boundaries

- No direct model-provider API calls.
- No arbitrary bot-owned model eval script.
- No unbounded retries.
- One work order per supervisor session at a time.
- No destructive action without explicit allow-list or user confirmation.
- Target project code changes should normally be delegated to that project's
  session, not performed inside the supervisor session.
- The bot's own repository should default to suggestion-only unless explicitly
  configured for supervised modification.
- Failed scheduled work should not immediately re-fire forever; retries happen
  inside the bounded work order, not by resetting the cron anchor repeatedly.

## Reports

Supervisor reports should be separate from Loop project reports but linked by
run id.

Supervisor report:

- work order id;
- supervisor session;
- started/ended/duration;
- final status;
- final marker observed or missing;
- actions taken;
- delegated project tasks;
- failures diagnosed;
- retries attempted;
- final verification;
- commits;
- follow-ups;
- raw final summary.

Loop project report keeps the existing command/round/eval/skill metadata.

## Implementation Slices

### Slice 1: Design and Schema

- Add `runner.kind` to Loop project config with default `system`.
- Add strict schema for `agent-supervised` options.
- Add WorkOrder types and pure builder tests.
- Do not start sessions yet.

### Slice 2: Supervisor Session

- Add `startLoopSupervisor` modeled after `startOperator`, with separate identity.
- Provision supervisor instructions in its state directory.
- Exclude it from project pickers and recovery like the home operator.
- Add tests for identity, provisioning, and exclusion.

### Slice 3: Dispatch Runner

- Add `runLoopSupervisedProjectAsync`.
- Dispatch WorkOrder to the supervisor session through the existing queue.
- Wait for final reply or timeout.
- Parse final marker and summary.
- Persist work order state.

### Slice 4: Service Integration and Reports

- In `runLoopServiceTickAsync`, choose runner by project config.
- Write supervisor reports and backlog suggestions.
- Notify success/failure/timeout.
- Add smoke coverage for a fake supervisor runner.

### Slice 5: Operational Polish

- Add CLI/status visibility for active supervisor work.
- Add docs and examples.
- Add TUI/dashboard visibility only after the core path is stable.

## Open Decisions

1. Should supervisor config live in the Loop config file or global `.env` config?
   Recommendation: loop config file for project-specific behavior; `.env` only for
   boot defaults if needed.
2. Should the supervisor be allowed to run `tcb loop run` recursively?
   Recommendation: yes, but only for the same work order/project and with explicit
   instructions to avoid recursion loops.
3. Should a missing final marker be `failed` or `timeout`?
   Recommendation: `timeout` when wall-clock expires; `failed` when the supervisor
   explicitly reports failure without the marker.
4. Should first version auto-commit supervised work?
   Recommendation: follow the existing Loop project `commit` policy; no separate
   supervisor commit policy.
