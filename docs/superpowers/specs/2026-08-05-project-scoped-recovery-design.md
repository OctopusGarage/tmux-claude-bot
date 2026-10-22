# Project-Scoped Historical Recovery Design

## Goal

Automatically recover historical scheduled-task failures that are safe to retry,
while preserving strict ownership and stopping for human or external decisions.

## Problem

The shared task ledger currently represents many unrelated outcomes as
`repairStatus=pending`. The existing Repair Coordinator can deduplicate and lease
bot-owned repair work, but it does not reconstruct a failed external project's
original Loop WorkOrder. Daily Audit therefore sees historical failures without a
safe project-specific dispatch path. The result is either no retry or an unsafe
temptation to use the bot repository's branch, worktree, or verification policy.

## Non-goals

- Do not let tmux-claude-bot edit repositories absent from the configured Loop
  project/workspace registry.
- Do not resolve PR conflicts, draft PR policy, design decisions, or external
  service/account failures automatically.
- Do not add direct model-provider API clients or a second agent runtime.
- Do not replay every historical failure unconditionally.
- Do not bypass the existing WorkOrder, worktree, branch, system-gate, or
  notification contracts.

## Design

### Ownership boundary

The Repair Coordinator remains the durable queue for evidence and deduplication.
A project-scoped Recovery Coordinator consumes only eligible records and resolves
their owner from the current Loop configuration:

1. Parse the project id from the ledger task id/name and known WorkOrder artifact
   metadata.
2. Resolve the project or workspace from the active Loop configuration.
3. Verify the configured repository path with `git -C <path> rev-parse
   --show-toplevel` before any sync, assessment, edit, or dispatch.
4. Reuse that project's branch, agent, worktree isolation, task family, and
   verification profile.
5. Refuse recovery when ownership, path, or configuration is ambiguous.

The bot-owned Daily Audit and Runtime Guardian consumers remain source-scoped and
must not claim project-scoped recovery records.

### Classification

Each pending repair candidate is classified deterministically from ledger fields,
supervisor artifacts, project configuration, and current external state:

- `retryable`: transient environment/setup failure, worker/handoff failure,
  invalid branch/worktree preparation, or bounded supervisor dispatch failure.
- `waiting-external`: CI runner, GitHub billing/permission, network, or external
  service condition that may recover without a code decision.
- `needs-owner-decision`: draft PR, merge conflict, design/security trade-off,
  ambiguous ownership, or a requested change outside the configured task policy.
- `superseded`: a later successful or terminal record proves this failure no
  longer represents current work.
- `dead-letter`: retry budget exhausted or evidence is permanently inconsistent.

The existing ledger repair statuses remain the compatibility surface. The
classification is stored as recovery metadata and maps to terminal ledger states
only when the next action is known:

| Classification | Queue action | Ledger action |
| --- | --- | --- |
| retryable | enqueue project-scoped recovery | `running` while delegated |
| waiting-external | delayed recheck with bounded backoff | remain `pending` with reason |
| needs-owner-decision | do not dispatch | `blocked` with actionable reason |
| superseded | no dispatch | `superseded` |
| dead-letter | no dispatch | `blocked` with exhausted-retry reason |

### Recovery record

Each recovery record stores:

- stable id and dedupe key
- original ledger task ids
- project id and configured repository identity
- task family and source
- classification and evidence summary
- attempt count, next attempt time, and lease
- last action and last blocker
- linked WorkOrder/run id when delegated

The record is durable and append-safe. Existing queue records are migrated without
changing their original source or task ids.

### Dispatch and concurrency

The Recovery Coordinator claims only due `retryable` records whose project is
currently configured and whose project lock is free. It creates a bounded
project-scoped WorkOrder through the existing supervisor dispatch function. The
WorkOrder prompt includes the original failure evidence, recovery classification,
required project path/branch policy, and an explicit instruction to update every
original ledger task id.

At most one recovery WorkOrder runs per project id. Different projects may run in
parallel subject to the existing supervisor pool. A lost lease becomes
`retryable` with exponential backoff; a terminal WorkOrder artifact reconciles the
queue and all linked ledger records.

### Existing historical data

The first migration is read-only classification. It must report counts by project
and classification before dispatching. Only records classified `retryable` and
owned by a configured project are eligible for automatic recovery. External
projects that are not configured remain `needs-owner-decision`, not silently
ignored.

### Notifications and observability

Daily Audit reports compact counts by classification and dispatch outcome. It does
not include absolute home-directory paths. Detailed evidence remains available in
the existing logs and run artifacts with `~` path redaction at user-facing
surfaces.

## Failure handling

- Missing project configuration: `needs-owner-decision`; no guessing.
- Git toplevel mismatch: `needs-owner-decision`; block before mutation.
- Project lock held: remain queued with no duplicate WorkOrder.
- Supervisor capacity full: retry with backoff and a bounded attempt count.
- External CI/service failure: `waiting-external`, then recheck; never edit blindly.
- Invalid or missing terminal artifact: retry once through the existing recovery
  policy, then `dead-letter` with evidence.
- Later success discovered: mark the old record `superseded`.

## Verification

- Unit tests for classification, project ownership, deduplication, backoff,
  lock/concurrency, and terminal reconciliation.
- Service tests proving Daily Audit cannot claim Runtime Guardian records and that
  project-scoped recovery uses the configured project policy.
- Migration tests proving the current 12 historical records are classified and
  none are silently discarded.
- Full `npm run verify:local`.
- Real dry-run classification, followed by one controlled retryable recovery
  through `tcb task audit --force --json` and verification of ledger, queue,
  WorkOrder, and notification state.
