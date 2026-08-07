# Repair Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Repair Coordinator that automatically consumes historical and new repair candidates without duplicate project mutations or permanent running state.

**Architecture:** Add a small state-machine module backed by the existing atomic JSON state store. Daily Audit and Runtime Guardian enqueue logical repair items; one coordinator tick imports unresolved ledger records, claims due items under project conflict gates, dispatches existing supervisor WorkOrders, and reconciles per-item outcomes after terminal or expired leases.

**Tech Stack:** TypeScript, existing `JsonMapStore`, existing `DailyTaskLedger`, Loop Supervisor/WorkOrder APIs, Vitest, Biome, `npm run verify:local`.

---

### Task 1: Define queue schema and deterministic state transitions

**Files:**
- Create: `src/core/tasks/repair-coordinator.ts`
- Test: `tests/tasks/repair-coordinator.test.ts`

- [ ] Write failing tests for dedupe-key stability, import of unresolved ledger records, priority ordering, project-level grouping, and lease expiry returning running items to retry-wait.
- [ ] Run `npx vitest run tests/tasks/repair-coordinator.test.ts --reporter=dot` and confirm the new module/API failures.
- [ ] Implement typed queue records, `RepairCoordinatorStore`, deterministic fingerprinting, import/reconcile helpers, bounded retry backoff, and atomic queue persistence using the existing state directory conventions.
- [ ] Run the focused test file and verify all queue state tests pass.
- [ ] Commit `feat: add durable repair coordinator state`.

### Task 2: Add coordinator dispatch and terminal reconciliation

**Files:**
- Modify: `src/core/tasks/repair-coordinator.ts`
- Modify: `src/core/autopilot/delegated-task.ts`
- Test: `tests/tasks/repair-coordinator.test.ts`
- Test: `tests/autopilot/delegated-task-supervisor-pool.test.ts`

- [ ] Write failing tests for dispatch blocking on an existing project WorkOrder, successful claim/dispatch, per-item report closure, failed WorkOrder retry scheduling, and exhausted attempts becoming dead-letter/blocked.
- [ ] Run the focused tests and confirm the missing coordinator integration behavior.
- [ ] Implement a coordinator dispatch adapter that calls the existing `startActiveDelegatedTask` boundary, claims only due compatible items, and stores the WorkOrder-to-queue mapping.
- [ ] Implement terminal reconciliation from WorkOrder state and supported task-report/ledger updates; never mark fixed from queueing alone.
- [ ] Run focused coordinator and delegated-task tests.
- [ ] Commit `feat: reconcile repair work orders durably`.

### Task 3: Make Daily Audit enqueue and consume the coordinator

**Files:**
- Modify: `src/core/tasks/daily-audit-service.ts`
- Modify: `src/index.ts`
- Test: `tests/tasks/daily-audit-service.test.ts`

- [ ] Write failing tests proving a current audit imports historical pending records, does not dispatch duplicate logical repairs, and keeps blocked projects retryable without marking them running.
- [ ] Run the focused Daily Audit tests and confirm failure.
- [ ] Replace direct candidate-to-WorkOrder mutation with coordinator enqueue plus one coordinator tick, while preserving current notification summaries and self-audit behavior.
- [ ] Start the coordinator from the managed service lifecycle with the existing task-audit/runtime timing and clean shutdown behavior.
- [ ] Run focused Daily Audit tests and the relevant service startup tests.
- [ ] Commit `feat: route daily audit repairs through coordinator`.

### Task 4: Route Runtime Guardian through the same queue

**Files:**
- Modify: `src/core/runtime-guardian/service.ts`
- Modify: `src/core/deps.ts` only if the lifecycle dependency must be typed
- Test: `tests/runtime-guardian.test.ts`

- [ ] Write failing tests proving Runtime Guardian findings enter the shared queue, dedupe against Daily Audit findings, and respect the same project conflict/lease rules.
- [ ] Run the focused Runtime Guardian tests and confirm failure.
- [ ] Replace direct runtime repair dispatch with coordinator enqueue while preserving fast-heal mode, cooldown, worktree policy, and finding evidence.
- [ ] Run focused Runtime Guardian tests and cross-module queue tests.
- [ ] Commit `feat: unify runtime guardian repair dispatch`.

### Task 5: Migrate historical pending records and document alignment

**Files:**
- Modify: `src/core/tasks/task-ledger.ts` only for shared unresolved-candidate helpers if needed
- Modify: `docs/intelligent-automation.md`
- Modify: `docs/automation-alignment.md`
- Modify: `docs/agent-maintenance-guidelines.md`
- Test: `tests/tasks/task-ledger.test.ts`
- Test: `tests/alignment-governance-contract.test.ts` if an enforced anchor changes

- [ ] Write failing migration tests for pending, running, blocked, fixed, superseded, and not-reproducible records, including duplicate delegated-task records.
- [ ] Run the focused migration tests and confirm failure.
- [ ] Implement idempotent startup migration/import; preserve evidence and never convert unresolved failures to success.
- [ ] Update automation ownership, queue lifecycle, operator visibility, and conflict/retry rules in the canonical docs and alignment matrix.
- [ ] Run focused migration and documentation-contract tests.
- [ ] Commit `feat: migrate historical repair backlog`.

### Task 6: Verify live behavior and finish

**Files:**
- Modify: only files required by failing verification
- Test: relevant focused suites and full local verification

- [ ] Run a read-only queue inventory against the live state and record expected counts before migration.
- [ ] Trigger one real audit tick through the supported CLI; verify one bounded WorkOrder, no duplicate project lease, and per-item terminal updates.
- [ ] Verify service restart recovery with an expired lease fixture and confirm no permanent `running` records remain.
- [ ] Run `npm run verify:local`.
- [ ] Run `git diff --check`, confirm a clean worktree, and report the final queue counts, active WorkOrders, blocked items, and commit list.
- [ ] Commit any final verification-only adjustments as `fix: close repair coordinator verification gaps`.
