# Autonomous Work Rhythm and Batch Scheduler Retirement

## Status

Approved for implementation on 2026-08-13. The operator delegated detailed
trade-offs to the implementation agent and requested completion without further
design checkpoints.

## Problem

tmux-claude-bot has two unrelated scheduling systems:

1. Loop Engineering and its WorkOrder-based automation platform, which is active
   and owns scheduled maintenance, delegated work, repair, durable evidence, and
   system gates.
2. A generic Batch Scheduler with its own plans, runs, pools, commands, stores,
   quota handling, and task lifecycle.

The live installation has no Batch plans, run, pool, or last-fired state and no
active Batch run. Keeping the second scheduler adds an idle production loop,
duplicate terminology, a large command and test surface, and a misleading
Runtime Overview domain.

Loop automation also starts scheduled work at exact cron occurrences. Resource
Guardian and quiet hours protect the host, but Loop, Autopilot, Daily Task Audit
repair, and Runtime Guardian repair do not share an account-capacity policy.
The current Loop Supervisor pool uses Codex with ChatGPT subscription
authentication, while its usage snapshots are unavailable. Service restart,
host wake, quota recovery, or repeated repair can therefore create bursts even
though CPU, worktree, and concurrency safety are otherwise governed.

## Goals

- Remove Batch Scheduler completely without removing the generic cron occurrence
  calculation used by Loop and Daily Task Audit.
- Treat a configured cron occurrence as the start of an execution window rather
  than an exact dispatch instant.
- Spread autonomous work with persisted random delay for load shaping, not for
  impersonation or provider-detection evasion.
- Preserve normal FIFO behavior for user chat and Autopilot work.
- Pause work when official account capacity is exhausted and resume at the
  reported reset time.
- Degrade safely when usage telemetry is unavailable.
- Prevent restart, wake, quota-reset, and repair catch-up storms.
- Make every admission, deferral, coalescing decision, and recovery observable.
- Preserve WorkOrder, Resource Guardian, host-power, repository isolation,
  system-gate, notification, and repair-coordinator invariants.

## Non-goals

- Do not simulate human behavior, disguise automation, vary timing to evade
  provider controls, or add meaningless prompt noise.
- Do not call model-provider HTTP APIs or add provider SDKs.
- Do not reorder already queued work, preempt in-flight work, or give user work
  queue priority.
- Do not invent Gemini support before a real Gemini agent adapter exists.
- Do not force host sleep or change the fixed operator-managed wake schedule.
- Do not convert every recovery or reconciliation action into model-backed work.

## Product Semantics

### Queue order

User chat and explicitly requested Autopilot work enter the existing queue
normally. They do not receive priority over earlier work. Autonomous admission
may delay a background item before it enters the queue, but no policy reorders,
cancels, or pauses an item after queue admission. Running work drains normally.

If account capacity is exhausted, every task requiring that agent account waits.
There is no force or bypass path.

### Scheduled execution window

A cron occurrence is a durable occurrence identity and window start. The default
window is `[occurrence, occurrence + 60 minutes]`.

The first observer of an eligible occurrence draws a cryptographically random
offset within the configured window and persists the chosen `notBefore` time.
Every restart reuses that value. The system must never redraw merely because the
service restarted or the task was deferred.

The delay exists to spread host and account load across projects. It is not an
attempt to make requests look human. Configuration supports a deterministic
zero-width window for tests and operators that require exact execution.

Event-driven repair and repository-review queue items do not pretend to be cron
occurrences. They retain their existing durable retry schedule and receive only
bounded recovery spreading after a common unblock event.

### User activity

Recent operator activity affects only autonomous items that have not entered the
queue. If an interactive agent is busy or an owner input was observed in the
previous 10 minutes, new autonomous admission is deferred. Admission is
reconsidered after 15 minutes of continuous inactivity.

This is a load-shaping policy, not queue priority. Existing queued and running
items are untouched.

### Capacity state

Capacity is evaluated per agent/account pool:

- `available`: fresh usage evidence is below the configured threshold.
- `constrained`: usage is close to the threshold; no new autonomous work enters,
  while already queued/running work drains.
- `exhausted`: explicit provider limit evidence or measured usage at/above the
  threshold; all work requiring the pool waits until the official reset.
- `unknown`: authentication or usage telemetry cannot establish a reliable
  state.

The `unknown` state is not treated as unlimited and does not permanently stop the
system. It permits at most one autonomous run globally for that agent pool,
requires at least 30 minutes between autonomous starts, rejects repair chaining,
and reprobes every 15 minutes. User work remains normally queueable.

Explicit rate/usage-limit errors update capacity evidence and carry the official
reset when available. Generic transport errors remain the responsibility of the
existing bounded transient retry policy and must not be mislabeled as account
exhaustion.

Authentication is recorded only as a safe category (`subscription`,
`usage-based`, `enterprise-automation`, or `unknown`). Credentials, tokens, and
personal account identifiers are never persisted.

### Catch-up and coalescing

The default catch-up policy is latest-occurrence coalescing:

- For one target and task family, only the latest unreserved occurrence remains
  eligible.
- Older occurrences become durable `superseded` evidence linked to the retained
  occurrence.
- Daily Task Audit may report every missing expected task, but the audit runner
  itself executes only once for the current audit window.
- Repair remains deduplicated by failure fingerprint through the global Repair
  Coordinator.
- After a shared unblock event such as wake or quota reset, eligible autonomous
  items receive a persisted 0-30 minute recovery spread.
- A task family may opt into `must-run-each-occurrence` only in the task-family
  governance registry. Callers cannot make ad hoc exceptions.

Coalescing does not advance a scheduler checkpoint past work that was neither
reserved nor explicitly superseded. Deferral does not count as a failure or
consume a retry.

### Prompt stability

There is no prompt randomizer. Supervisor prompts retain a stable governance
contract: objective, non-goals, permissions, WorkOrder identity, acceptance
criteria, output schema, tests, system gates, and cleanup policy.

Dynamic prompt content may contain only truthful execution context, such as
recent failure evidence, changed files, prior incomplete work, current time and
resource budget, or already-completed steps. Optional prose ordering may vary
only when it is semantically equivalent and covered by the same prompt contract.
The rendered prompt and its contract/version fingerprint remain durable evidence.

## Architecture

### Shared occurrence module

Move generic `Schedule`, cron parsing, `nextFire`, and occurrence helpers out of
`core/scheduler` into a neutral deep module under `core/scheduling`. Loop and
Daily Task Audit depend on this module. Everything else in `core/scheduler` is
Batch-owned and is removed.

### Autonomous Work Admission module

Deepen the existing `admitAutomationWork` seam into one module with this logical
interface:

```text
plan(intent) -> planned occurrence or durable deferral
admit(planned occurrence) -> admitted lease or durable deferral
settle(lease, outcome) -> updated capacity and occurrence evidence
snapshot() -> safe operator view
```

Callers supply an `AutomationIntent` with target, task family, trigger, agent,
occurrence, and coalescing policy. They do not independently implement jitter,
capacity thresholds, activity gates, resource gates, or quiet-hour behavior.

The module hides these internal seams:

- occurrence store and random offset selection;
- agent authentication/usage probe adapters;
- recent owner and interactive-agent activity reader;
- Resource Guardian and host-power admission readers;
- capacity lease and cooldown store;
- rate-limit outcome classifier;
- append-only bounded decision journal.

Resource Guardian and quiet hours remain authoritative modules; autonomous
admission composes their decisions rather than copying their policies.

### Two-stage admission

Admission is checked twice:

1. Before durable WorkOrder/scheduler reservation, so deferral does not consume a
   schedule occurrence or retry.
2. Immediately before a supervisor prompt is enqueued, so changed quota,
   activity, quiet-hour, or resource state cannot be bypassed by a long
   preparation phase.

The second check reuses the same occurrence and lease identity. It never redraws
timing. A denial releases the provisional lease and preserves eligibility.

### Durable state

State lives under the canonical app state directory:

- `automation-admission/current.json`: schema-versioned pool state and cooldowns;
- `automation-admission/occurrences.json`: bounded planned/eligible/superseded
  occurrences and chosen `notBefore` times;
- `automation-admission/events/YYYYMMDD.jsonl`: low-frequency admission decisions.

Writes are atomic. Corrupt current state fails background-closed, preserves the
bad bytes for diagnosis, and does not block already queued/running work. Event
journaling is best effort and cannot turn an otherwise safe denial into an
admission.

Occurrence retention is bounded by age and count. User-facing paths are
tildeified; secrets and account identifiers are not part of the schema.

## Batch Scheduler Retirement

Delete:

- Batch startup wiring and idle timer;
- plan/run/pool/quota/reconciliation modules and their tests;
- `tcb batch` and `/batch` commands;
- Batch automation pause/resume registration;
- `BATCH_SCHEDULER_*` schema, config, examples, and generic config keys;
- Batch Runtime Overview domain and capability-matrix entries;
- Batch-specific i18n, notifications, manuals, and alignment rules;
- Batch state readers and dead state names.

Preserve:

- generic cron occurrence calculations after migration;
- unrelated uses of the English word "batch" such as batched PR decisions or
  opportunity actions;
- historical ledger records with source `batch-scheduler`; they remain readable
  evidence but no new records are produced.

No live Batch state exists, so no migration command is required. Removal must not
delete arbitrary operator files. If legacy scheduler state is encountered in a
future installation, it is ignored and documented as safely removable rather
than automatically destroyed.

## Operator Surfaces

Add a compact `Agent Capacity` domain to Runtime Overview and expose a dedicated
safe CLI:

```text
tcb automation capacity status [--json]
tcb automation capacity history [--since <time>] [--json]
```

Status includes agent, safe authentication category, state, evidence freshness,
five-hour/weekly usage when available, reset time, active autonomous leases,
cooldown, and the latest deferral reason.

The same read model feeds CLI, TUI Runtime Overview, Telegram/Lark dashboard,
Observer MCP, and the Home Operator skill. Mutating controls are intentionally
absent initially. Existing `tcb automation pause/resume` remains the explicit
operator control for the automation families that still exist.

Notifications are transition-based and bounded: first exhaustion, recovery,
prolonged telemetry loss, or corrupt state. Repeated ticks do not spam.

## Configuration

Defaults are conservative and product-owned:

- scheduled window: 60 minutes;
- recovery spread: 30 minutes;
- recent owner activity: 10 minutes;
- required idle duration: 15 minutes;
- unknown telemetry autonomous concurrency: 1;
- unknown telemetry minimum start interval: 30 minutes;
- telemetry reprobe: 15 minutes;
- constrained threshold: below the existing hard quota threshold with a reserve
  margin validated against observed provider data.

Expose only settings that operators plausibly need. Use dedicated typed
`tcb automation capacity ...` controls if mutation becomes necessary; do not add
credentials or provider identities to generic config.

## Failure Semantics

- `not-before`, recent activity, quiet hours, resource pressure, constrained
  capacity, and exhausted capacity are `deferred`, not failed.
- A deferral does not advance last-fired, consume retry budget, create a repair,
  or emit a failure notification.
- Exhaustion with a reset schedules one reprobe near that reset; exhaustion
  without reset uses bounded exponential reprobe capped at 30 minutes.
- Usage telemetry parse/read failure becomes `unknown`, not zero usage.
- Capacity state corruption is background-closed until a valid observation is
  persisted.
- After the maximum execution window, a still-valid occurrence remains deferred
  or is coalesced by the next occurrence according to its task-family policy; it
  is never silently dropped.

## Verification

Contract tests must cover:

- persisted jitter is within the window and stable across restart;
- zero-width windows are exact and deterministic;
- FIFO is unchanged after queue admission;
- recent user activity delays only unqueued autonomous work;
- available/constrained/exhausted/unknown transitions and reset handling;
- unknown-mode single concurrency, cooldown, reprobe, and repair-chain refusal;
- two-stage admission with state change between planning and enqueue;
- deferral does not mutate checkpoint, retry, ledger failure, or WorkOrder state;
- latest-occurrence coalescing and explicit must-run-each policy;
- restart/wake/quota-reset recovery spread does not redraw;
- malformed telemetry and corrupt durable state fail safely;
- prompts preserve the governance contract and contain no random noise;
- Batch commands, config, startup, Runtime Overview, docs, and dependency graph
  are absent while Loop/Daily Audit cron behavior remains covered.

Run focused suites, source and test type checking, Biome, dependency-cruiser,
documentation/alignment contracts, and `npm run verify:local` before completion.

## Rollout

1. Remove Batch Scheduler and migrate shared occurrence code.
2. Add the admission store and decision engine in observe mode while retaining
   existing resource/quiet-hour denials.
3. Wire scheduled Loop and background repair producers through planning and
   two-stage admission.
4. Add operator visibility and compare decisions against live behavior.
5. Enable enforcement for timing/activity/capacity after the same release's
   contract tests establish fail-safe behavior. Unknown telemetry enforcement is
   enabled with its conservative fallback; it does not require provider APIs.

Each slice must end verified and committed or be cleaned up before the next
slice. No opportunistic architecture sweep is part of this design.
