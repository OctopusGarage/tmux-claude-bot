# Automation Architecture Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen recovery admission, system-gate findings, and shared notification intent without changing target-project ownership.

**Architecture:** A recovery-admission module owns durable queue lifecycle while source adapters supply structured findings. System gates emit structured findings in an additive artifact field. A core notification-intent module produces channel-neutral content that Telegram and Lark render with their existing implementations.

**Tech Stack:** TypeScript, Vitest, persistent JSON state, Telegram and Lark adapters.

---

### Task 1: Recovery admission

**Files:**
- Create: `src/core/tasks/recovery-admission.ts`
- Test: `tests/tasks/recovery-admission.test.ts`
- Modify: `src/core/tasks/daily-audit-service.ts`
- Modify: `src/core/runtime-guardian/service.ts`

- [ ] Write a failing test that one structured finding is enqueued, claimed, delegated, and marked running through one interface.
- [ ] Run `npm test -- --run tests/tasks/recovery-admission.test.ts` and confirm RED.
- [ ] Implement `admitRecoveryFindings` with a `RecoveryFinding` input and a `RecoveryAdmissionResult` output; it owns deduplication, claims, dispatch, and immediate capacity deferral.
- [ ] Migrate Daily Audit and Runtime Guardian to call the module rather than own those transitions.
- [ ] Run focused tests and commit `feat: centralize recovery admission`.

### Task 2: Structured system-gate findings

**Files:**
- Modify: `src/core/loop/service.ts`
- Modify: `src/core/loop/execution-worktree.ts`
- Modify: `src/core/runtime-guardian/service.ts`
- Test: `tests/loop/service-supervisor.test.ts`
- Test: `tests/loop/execution-worktree.test.ts`
- Test: `tests/runtime-guardian/service.test.ts`

- [ ] Write a failing test for additive `system-gate.json.findings` records containing code, disposition, retry policy, evidence, and display text.
- [ ] Run the three focused test files and confirm RED.
- [ ] Implement source-produced structured findings; retain legacy strings only for human-compatible output.
- [ ] Make Runtime Guardian consume structured findings and treat missing fields as legacy repairable investigation work.
- [ ] Run focused tests and commit `feat: persist structured system gate findings`.

### Task 3: Channel-neutral automation notification intent

**Files:**
- Create: `src/core/notifications/automation-intent.ts`
- Modify: `src/core/tasks/daily-audit.ts`
- Modify: relevant Telegram and Lark notification adapters
- Test: `tests/core/notifications/automation-intent.test.ts`

- [ ] Write a failing pure intent test for severity, title, summary, issue rows, and repair state.
- [ ] Run `npm test -- --run tests/core/notifications/automation-intent.test.ts` and confirm RED.
- [ ] Implement the pure core intent module; keep Markdown/card rendering and transport in the adapters.
- [ ] Migrate Daily Audit, then add adapter regressions showing existing presentation still renders.
- [ ] Run focused tests and commit `feat: add automation notification intent`.

### Task 4: Final verification

**Files:**
- Modify: `docs/automation-alignment.md`

- [ ] Add alignment invariants for the new deep modules.
- [ ] Run `npm run verify:local`.
- [ ] Confirm `git ls-files -- state` is empty and worktree is clean.
- [ ] Commit final docs, fast-forward `dev`, push, and verify CI.
