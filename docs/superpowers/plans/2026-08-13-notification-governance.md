# Notification Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proactive notifications concise, actionable, and restart-safe while preserving explicit operator sends and interactive results.

**Architecture:** Domain producers classify notification meaning; `NotificationGateway` applies durable per-channel delivery policy through a focused `NotificationPolicyStore`. Existing observability artifacts remain authoritative, while chat delivery becomes an escalation surface instead of a duplicate event log.

**Tech Stack:** TypeScript, Node.js filesystem primitives, Vitest, Biome, dependency-cruiser.

---

### Task 1: Durable gateway policy and concise rendering

**Files:**
- Create: `src/core/notifications/policy-store.ts`
- Modify: `src/core/notifications/gateway.ts`
- Test: `tests/core/notifications/policy-store.test.ts`
- Test: `tests/core/notifications/gateway.test.ts`

- [x] Add failing tests for durable state-change and once-per-window suppression, per-channel partial retry, corrupt-state fail-open, source metadata without visible `source:`, and always-send compatibility.
- [x] Run `npx vitest run tests/core/notifications/policy-store.test.ts tests/core/notifications/gateway.test.ts` and confirm the new contracts fail.
- [x] Implement a bounded atomic policy store and gateway planning/recording around successful channel delivery.
- [x] Run the focused suites and confirm they pass.

### Task 2: Power, audit, resource, and capacity producer policy

**Files:**
- Modify: `src/core/power/power-manager.ts`
- Modify: `src/core/tasks/daily-audit.ts`
- Modify: `src/core/tasks/daily-audit-service.ts`
- Modify: `src/core/notifications/events.ts`
- Modify: `src/core/resource-guardian/service.ts`
- Modify: `src/core/loop/service.ts`
- Modify: `src/core/autopilot/delegated-task.ts`
- Test: `tests/core/power-manager.test.ts`
- Test: `tests/tasks/daily-audit-service.test.ts`
- Test: `tests/core/notifications/events.test.ts`
- Test: `tests/resource-guardian/service.test.ts`
- Test: `tests/core/automation/coordinator.test.ts`

- [x] Add failing tests that battery-only power is informational, actionable power failures are once per quiet cycle, healthy audits suppress delivery without failing settlement, Resource Guardian ignores elevated/intermediate phases and pairs recovery, and capacity transitions use durable state-change metadata.
- [x] Run the focused suites and confirm the policy assertions fail.
- [x] Add producer delivery metadata and concise copy; treat a suppressed audit notification as a successful audit outcome.
- [x] Run the focused suites and confirm they pass.

### Task 3: Remove duplicate generic and startup notifications

**Files:**
- Modify: `src/core/notifications/long-task-monitor.ts`
- Modify: `src/core/infra/lifecycle.ts`
- Modify: `src/index.ts`
- Modify: `src/adapters/telegram/start.ts`
- Modify: `src/adapters/lark/start.ts`
- Test: `tests/core/notifications/long-task-monitor.test.ts`
- Test: `tests/core/lifecycle.test.ts`
- Test: `tests/adapters/telegram/start-notifications.test.ts`

- [x] Add failing tests that reserved infrastructure sessions never produce generic long-task notifications and that one durable crash occurrence routes through the shared gateway.
- [x] Run the focused suites and confirm the new contracts fail.
- [x] Filter reserved infrastructure sessions and move crash recovery delivery out of adapters into one preferred-channel gateway request with fallback semantics.
- [x] Run the focused suites and confirm they pass.

### Task 4: Alignment and full verification

**Files:**
- Modify: `docs/automation-alignment.md`
- Modify: `docs/intelligent-automation.md`
- Modify: `docs/automation-capability-matrix.md`
- Modify: `docs/agent-maintenance-guidelines.md`
- Modify: `docs/manual.md`

- [x] Document notification classes, source decisions, durable per-channel suppression, concise rendering, and explicit-send exemption.
- [x] Run `npx biome check` on touched files, production and test typechecks, and all focused notification suites.
- [x] Run `npm run verify:local` and require `verify-local ok`.
- [x] Review `git diff --check`, status, and unpushed commit boundaries before reporting completion.
