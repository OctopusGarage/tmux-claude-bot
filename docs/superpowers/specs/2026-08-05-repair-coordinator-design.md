# Repair Coordinator Design

## Goal

Give Daily Task Audit and Runtime Guardian one durable, autonomous repair path
that consumes historical and newly discovered repair candidates without manual
force-triggering, duplicate project mutations, or permanent `running` state.

## Current gap

Daily Task Audit only dispatches candidates discovered in its current Singapore
calendar-day window. Runtime Guardian only dispatches runtime-artifact findings.
Neither component owns historical `repairStatus=pending` records, so failed
records outside the current window can remain pending indefinitely. The existing
dispatch path also marks a batch as running before every item has an individual
result and relies on the worker to close the batch after a restart-safe lease.

## Recommended architecture

Add a service-owned Repair Coordinator with a durable queue under the configured
state directory. Daily Audit and Runtime Guardian become producers; the
Coordinator is the single consumer that decides when a repair WorkOrder may be
created.

```text
Daily Audit ───────┐
                   ├─> Repair Coordinator ─> durable repair queue
Runtime Guardian ──┘                         │
                                             v
                                  project-conflict gate
                                             │
                                             v
                                      Repair WorkOrder
                                             │
                                             v
                             per-item report + system acceptance
```

The Coordinator must remain a thin service boundary. Agent reasoning and any
native agent subagents remain inside the existing supervisor/worker surface; no
model-provider client or second agent runtime is introduced.

## Queue model

Each logical repair item has a stable dedupe key derived from the source,
project identity, task family, and normalized failure fingerprint. Multiple
ledger task IDs may point to one logical queue item. The queue record contains:

- `id`, `dedupeKey`, `projectId`, canonical project path, source, task family;
- linked ledger task IDs and evidence summaries;
- `status`: `pending`, `leased`, `running`, `retry-wait`, `fixed`, `blocked`,
  `not-reproducible`, `superseded`, or `dead-letter`;
- attempt count, next-attempt time, lease owner, lease expiry, created/updated
  timestamps, and the last outcome.

The queue is persisted atomically and treated as recoverable state. A schema
version and migration path are required so existing ledger records can be
imported without hand-editing live state.

## Scheduling and safety

The Coordinator runs on the existing service tick and on startup recovery. Each
tick:

1. Reclaims expired `leased`/`running` items and converts them to retryable
   state with bounded backoff.
2. Imports unresolved historical ledger records that are not already linked to
   a queue item.
3. Collapses duplicate records by dedupe key.
4. Selects due items by priority: current-window failures, recent failures,
   then historical failures.
5. Groups only compatible items for one repair WorkOrder.
6. Applies the existing project automation conflict and worktree-isolation
   gates before dispatch.
7. Claims the batch with a lease before dispatch and writes each item result
   back through the supported task-report/ledger contract.

Only one mutating repair WorkOrder may own a project at once. A normal Loop
Engineering WorkOrder, PR review, Autopilot task, or another repair keeps the
queue item pending with a retry time; it does not create a second worker.

Dispatch capacity is bounded per tick and per project. Retryable failures use
exponential backoff with a maximum attempt count. Evidence failures, external
permissions, network failures, dirty/mismatched worktrees, and missing final
artifacts become `blocked` or `dead-letter` according to the existing failure
classification rather than being retried indefinitely.

## Completion and crash recovery

The coordinator owns the batch lifecycle. A worker must report each linked task
ID independently, but a missing report cannot leave the queue permanently
running. When the WorkOrder reaches a terminal state, the Coordinator reconciles
all linked items:

- reported successful verification -> `fixed`;
- verified historical duplicate -> `superseded`;
- safe but impossible to reproduce -> `not-reproducible`;
- actionable but blocked by evidence or policy -> `blocked`;
- retryable infrastructure/agent failure -> `retry-wait`;
- exhausted attempts or expired evidence -> `dead-letter`.

Lease expiry and service restart use the same reconciliation path. No state is
marked `fixed` merely because a WorkOrder was queued or because an agent sent a
partial summary.

## Existing-data migration

Migration is conservative:

- import only ledger records with unresolved repair states;
- preserve every original task ID and evidence summary;
- link repeated delegated-task records when their normalized project/family/
  failure fingerprint matches;
- preserve `blocked`, `fixed`, `superseded`, and `not-reproducible` records as
  terminal evidence;
- do not mark old failures successful without a later verified outcome.

The current historical backlog is therefore processed in bounded batches, not
blindly replayed as one large repair.

## Observability and notifications

The queue and dashboard expose counts for due, leased, running, retry-wait,
blocked, dead-letter, and terminal outcomes. Notifications report only bounded
aggregates and human-readable reasons; they must use home-path redaction and
must not include raw absolute personal paths, task IDs, or full agent output.

## Verification

The implementation requires:

- unit tests for dedupe, migration, priority, lease expiry, backoff, conflict
  blocking, per-item closure, and terminal WorkOrder reconciliation;
- service tests proving Daily Audit and Runtime Guardian enqueue instead of
  directly creating duplicate repairs;
- restart/recovery tests proving stale `running` records become retryable;
- a real local smoke test that imports the existing pending backlog, dispatches
  one bounded batch, and verifies fixed/blocked/pending counts;
- `npm run verify:local` before claiming completion.

## Scope exclusions

This change does not add a new CLI command, chat workflow, model-provider API,
external database, or new agent role. Existing task-report and WorkOrder
interfaces remain the public contract; the Coordinator only supplies the
missing durable ownership and recovery layer.
