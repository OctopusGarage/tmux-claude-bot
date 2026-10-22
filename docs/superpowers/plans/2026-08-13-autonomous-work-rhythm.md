# Autonomous Work Rhythm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the unused Batch Scheduler and govern scheduled/background model work through one auditable, restart-stable, capacity-aware admission path without changing FIFO semantics for user work.

**Architecture:** Generic cron calculation moves to `core/scheduling`; Batch-owned code and surfaces are deleted. Existing Loop occurrence jitter is deepened into a persisted execution-window planner, while `core/automation/admission` composes quiet hours, recent operator activity, Resource Guardian, and agent-capacity policy before reservation and before dispatch. A bounded read model powers CLI and Runtime Overview; no provider API client or prompt randomizer is introduced.

**Tech Stack:** TypeScript, Node.js synchronous state primitives, Commander, Vitest, Zod/config schema, existing WorkOrder/Loop/Resource Guardian modules.

---

## File map

- `src/core/scheduling/occurrence.ts`: provider-neutral `Schedule`, cron parser, and `nextFire`.
- `src/core/automation/occurrence-window.ts`: persisted occurrence identity, random `notBefore`, coalescing, and recovery spread.
- `src/core/automation/capacity.ts`: pure capacity state derivation and admission policy.
- `src/core/automation/capacity-store.ts`: validated, atomic capacity/lease/decision persistence.
- `src/core/automation/capacity-command.ts`: safe `status` and bounded `history` read surface.
- `src/core/automation/admission.ts`: one composition seam for timing, activity, capacity, quiet hours, and Resource Guardian.
- `src/core/loop/scheduler.ts`: scheduled occurrence discovery only; delegates execution-window planning.
- `src/core/loop/service.ts`: calls admission before WorkOrder reservation and before queue dispatch; records leases/outcomes.
- `src/core/dashboard/runtime-overview-*.ts`: replaces Batch domain with Agent Capacity.
- `src/core/scheduler/**`: deleted after the neutral cron and quota primitives have moved.

### Task 1: Move neutral cron behavior and retire Batch code

**Files:**
- Create: `src/core/scheduling/occurrence.ts`
- Create: `tests/core/scheduling/occurrence.test.ts`
- Modify: `src/core/loop/scheduler.ts`
- Modify: `src/core/tasks/task-discovery.ts`
- Modify: `src/core/tasks/daily-audit-service.ts`
- Modify: `src/index.ts`
- Delete: `src/core/scheduler/**`
- Delete: `tests/scheduler/**`

- [ ] **Step 1: Add the failing neutral occurrence tests**

```ts
import { describe, expect, it } from "vitest";
import { nextFire } from "../../../src/core/scheduling/occurrence.js";

describe("nextFire", () => {
  it("returns the first cron minute strictly after the anchor", () => {
    expect(nextFire({ kind: "cron", cron: "5 * * * *" }, Date.UTC(2026, 7, 13, 1, 5))).toBe(
      Date.UTC(2026, 7, 13, 2, 5),
    );
  });
  it("preserves now and one-shot at semantics", () => {
    expect(nextFire({ kind: "now" }, 10)).toBe(10);
    expect(nextFire({ kind: "at", at: 11 }, 10)).toBe(11);
    expect(nextFire({ kind: "at", at: 10 }, 10)).toBeNull();
  });
});
```

- [ ] **Step 2: Run `npx vitest run tests/core/scheduling/occurrence.test.ts` and confirm the missing-module RED.**

- [ ] **Step 3: Move only `Schedule`, `nextCronFire`, and `nextFire` verbatim into the neutral module and repoint Loop/Daily Audit imports.**

```ts
export type Schedule =
  | { kind: "now" }
  | { kind: "at"; at: number }
  | { kind: "cron"; cron: string };
```

- [ ] **Step 4: Remove `startScheduler` from startup, then delete Batch modules/tests after `rtk rg 'core/scheduler|batch-scheduler' src tests` shows no non-Batch dependency.**

- [ ] **Step 5: Run the neutral scheduling, Loop scheduler, task discovery, and Daily Audit suites; expect all PASS.**

- [ ] **Step 6: Commit `refactor(automation): retire batch scheduler core`.**

### Task 2: Remove Batch product/configuration surfaces

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/adapters/telegram/handlers.ts`
- Modify: `src/adapters/lark/handlers.ts`
- Modify: `src/adapters/lark/commands.ts`
- Modify: `src/core/command/help-catalog.ts`
- Modify: `src/core/config/automation-command.ts`
- Modify: `src/core/config/config-command.ts`
- Modify: `src/cli/configuration-commands.ts`
- Modify: `src/shared/config.ts`
- Modify: `src/shared/types.ts`
- Modify: `.env.example`
- Modify: `src/core/autopilot/notifier.ts`
- Modify: `src/core/i18n/catalog/{en,es,ja,yue,zh,zh-TW}.ts`
- Delete: `docs/examples/batch-plan.example.yml`
- Test: `tests/cli-command-tree.test.ts`
- Test: `tests/core/config/automation-command.test.ts`

- [ ] **Step 1: Add RED assertions that `tcb batch`, `/batch`, Batch automation id, and `BATCH_SCHEDULER_*` are absent.**

```ts
expect(commandNames(program)).not.toContain("batch");
expect(runAutomationCommand(["status"], deps).stdout).not.toContain("Batch Scheduler");
expect(AutomationIdSchema.safeParse("batch").success).toBe(false);
```

- [ ] **Step 2: Remove Batch CLI/chat/help/i18n/config/notifier branches and the three environment keys; leave unrelated opportunity/PR batching untouched.**

- [ ] **Step 3: Run config, command-tree, Telegram, Lark, i18n, and notifier suites; expect PASS and no `batchRun*` union member.**

- [ ] **Step 4: Commit `feat(automation): remove batch scheduler surfaces`.**

### Task 3: Persist execution windows and coalescing

**Files:**
- Create: `src/core/automation/occurrence-window.ts`
- Create: `tests/core/automation/occurrence-window.test.ts`
- Modify: `src/core/loop/scheduler.ts`
- Modify: `src/core/loop/schedule-jitter.ts`
- Modify: `src/core/loop/task-family.ts`
- Modify: `tests/loop/scheduler.test.ts`
- Modify: `tests/loop/schedule-jitter.test.ts`

- [ ] **Step 1: Write RED tests for a bounded random value, restart stability, zero-width exactness, latest-occurrence superseding, and 0–30 minute unblock spread.**

```ts
const first = store.plan({ key: "project:a:architecture", scheduledAt: 1_000, windowMs: 3_600_000, now: 1_000 });
const restored = new OccurrenceWindowStore({ stateDir: dir }).plan({
  key: first.key,
  scheduledAt: 1_000,
  windowMs: 3_600_000,
  now: 1_100,
});
expect(restored.notBefore).toBe(first.notBefore);
expect(first.notBefore).toBeGreaterThanOrEqual(1_000);
expect(first.notBefore).toBeLessThanOrEqual(3_601_000);
```

- [ ] **Step 2: Implement schema-versioned occurrence records using `JsonMapStore` at `automation-admission/occurrences.json`; draw with `randomInt(0, windowMs + 1)` only when the identity is first observed.**

```ts
export type AutomationOccurrence = {
  schemaVersion: 1;
  key: string;
  scheduledAt: number;
  notBefore: number;
  status: "planned" | "admitted" | "settled" | "superseded";
  retainedBy?: string;
  updatedAt: number;
};
```

- [ ] **Step 3: Replace Loop's hash-derived offset with the store's persisted `notBefore`; keep a pure injected random function for deterministic tests.**

- [ ] **Step 4: Mark older unreserved occurrences for the same family/target `superseded`, and retain the latest. Do not advance `loop_lastfired.json` on a timing deferral.**

- [ ] **Step 5: Run focused Loop scheduling tests; expect persisted and coalesced behavior PASS.**

- [ ] **Step 6: Commit `feat(automation): persist autonomous execution windows`.**

### Task 4: Add capacity state, recent-activity policy, and durable evidence

**Files:**
- Create: `src/core/automation/capacity.ts`
- Create: `src/core/automation/capacity-store.ts`
- Create: `tests/core/automation/capacity.test.ts`
- Create: `tests/core/automation/capacity-store.test.ts`
- Modify: `src/core/notifications/owner-activity.ts`
- Modify: `tests/core/notifications/owner-activity.test.ts`
- Modify: `src/core/automation/admission.ts`
- Modify: `src/core/resource-guardian/types.ts`

- [ ] **Step 1: Write RED table tests for `available`, `constrained`, `exhausted`, and `unknown`, including official reset, stale/invalid telemetry, unknown single lease, 30-minute cooldown, 15-minute reprobe, recent owner activity, and repair-chain refusal.**

```ts
expect(decideCapacityAdmission({
  now: 1_000,
  capacity: { state: "exhausted", resetAt: 2_000 },
  trigger: "background",
  activeLeases: 0,
  lastAutonomousStartAt: null,
  repairDepth: 0,
})).toEqual({ allowed: false, reason: "capacity-exhausted", retryAt: 2_000 });
```

- [ ] **Step 2: Implement typed state and strict validation. Invalid state returns `unknown` with background closed until a fresh observation is saved; it is never interpreted as zero usage.**

```ts
export type AgentCapacityState = "available" | "constrained" | "exhausted" | "unknown";
export type AgentCapacityView = {
  agent: "claude" | "codex";
  authentication: "subscription" | "usage-based" | "enterprise-automation" | "unknown";
  state: AgentCapacityState;
  fiveHourPct: number | null;
  weeklyPct: number | null;
  resetAt: number | null;
  observedAt: number;
  activeAutonomousLeases: number;
  lastAutonomousStartAt: number | null;
  nextProbeAt: number;
  latestReason: string;
};
```

- [ ] **Step 3: Extend `OwnerActivityTracker` to retain `lastObservedAt` with an injected/current clock while preserving its channel API.**

- [ ] **Step 4: Compose admission in this order: timing window → recent owner/interactive activity → quiet hours → capacity → Resource Guardian. Return typed `deferred` evidence without queue/checkpoint/retry mutation.**

- [ ] **Step 5: Remove `batch-scheduler` from `ResourceAdmissionInput.source`; run capacity, activity, admission, Resource Guardian, Autopilot delegation, and Daily Audit admission suites.**

- [ ] **Step 6: Commit `feat(automation): govern autonomous account capacity`.**

### Task 5: Wire two-stage Loop/repair admission and outcome settlement

**Files:**
- Modify: `src/core/loop/service.ts`
- Modify: `src/core/loop/supervised-runner.ts`
- Modify: `src/core/autopilot/delegated-task.ts`
- Modify: `src/core/tasks/daily-audit-service.ts`
- Modify: `src/core/runtime-guardian/service.ts`
- Modify: `src/core/resource-guardian/repair.ts`
- Test: `tests/loop/service*.test.ts`
- Test: `tests/autopilot-delegated-task.test.ts`
- Test: `tests/daily-audit-service.test.ts`
- Test: `tests/runtime-guardian/service.test.ts`
- Test: `tests/resource-guardian/repair*.test.ts`

- [ ] **Step 1: Add RED integration tests proving denial before reservation creates no WorkOrder, denial before enqueue releases the provisional capacity lease, queued/running work is untouched, and user/operator-triggered Autopilot remains normal FIFO.**

- [ ] **Step 2: Pass a stable `AutomationIntent` into both gates.**

```ts
type AutomationIntent = {
  id: string;
  source: ResourceAdmissionInput["source"];
  trigger: ResourceAdmissionInput["trigger"];
  agent: AgentKind;
  targetId: string;
  taskFamily: string;
  scheduledAt: number | null;
  repairDepth: number;
};
```

- [ ] **Step 3: Acquire one provisional capacity lease after planning; revalidate the same lease immediately before queue send. On deferral, release without consuming retry or last-fired. On successful start, atomically mark the occurrence admitted and capacity start timestamp.**

- [ ] **Step 4: Classify only explicit provider quota/usage-limit outcomes as exhausted. Persist an official parsed reset when present; leave transport errors to existing bounded retry.**

- [ ] **Step 5: Run all producer-focused tests; expect no repair chaining under unknown capacity and no change to user queue ordering.**

- [ ] **Step 6: Commit `feat(automation): enforce autonomous admission lifecycle`.**

### Task 6: Add safe capacity visibility and replace the Batch dashboard domain

**Files:**
- Create: `src/core/automation/capacity-command.ts`
- Create: `src/cli/automation-capacity-commands.ts`
- Create: `tests/core/automation/capacity-command.test.ts`
- Create: `tests/cli-automation-capacity.test.ts`
- Modify: `src/cli/configuration-commands.ts`
- Modify: `src/core/dashboard/runtime-overview-production.ts`
- Modify: `src/core/dashboard/runtime-overview-reader.ts`
- Modify: `src/core/dashboard/runtime-overview.ts`
- Modify: `src/mcp/observer.ts`
- Modify: `src/mcp/home.ts`
- Modify: Home Operator skill references under `.agents/skills`
- Modify: TUI/chat Runtime Overview renderers and i18n catalogs

- [ ] **Step 1: Add RED CLI tests for `tcb automation capacity status [--json]` and bounded `history --since`, asserting safe auth categories, reset/cooldown/lease counts, no absolute home path, no token/account identifier, and a maximum record count.**

- [ ] **Step 2: Implement one `AgentCapacityView` reader and renderer; every CLI/TUI/chat/MCP/Home surface consumes it rather than rereading state independently.**

- [ ] **Step 3: Remove the Batch Runtime Domain and add Agent Capacity health/attention rows with localized labels for chat and an explicitly documented English terminal exception.**

- [ ] **Step 4: Add typed MCP output schemas and structured scope/evidence for capacity status/history. Keep the Home surface read-oriented; do not expose a force/bypass mutation.**

- [ ] **Step 5: Run CLI tree, Runtime Overview, dashboard localization, MCP Observer/Home contract, TUI, and chat suites.**

- [ ] **Step 6: Commit `feat(automation): expose autonomous capacity status`.**

### Task 7: Align documentation, configuration, and verification contracts

**Files:**
- Modify: `docs/intelligent-automation.md`
- Modify: `docs/intelligent-automation-architecture.md`
- Modify: `docs/automation-alignment.md`
- Modify: `docs/automation-capability-matrix.md`
- Modify: `docs/ai-tool-surface-governance.md`
- Modify: `docs/manual.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/commands.md`
- Modify: `llms.txt`
- Modify: `.env.example`
- Modify: alignment/documentation tests

- [ ] **Step 1: Replace Batch descriptions with Autonomous Work Admission and Agent Capacity; document load-shaping/non-evasion boundary, FIFO semantics, official reset waiting, unknown fallback, coalescing, and no provider API client.**

- [ ] **Step 2: Update the capability matrix for CLI/TUI/chat/MCP/Home ownership and add drift assertions for removed Batch commands/config/docs and required capacity surfaces.**

- [ ] **Step 3: Run `rtk rg -n 'Batch Scheduler|BATCH_SCHEDULER|tcb batch|/batch' src tests docs .env.example`; classify every remaining match as intentionally historical/unrelated or remove it.**

- [ ] **Step 4: Run `npm run lint:types`, `npm run lint:types:tests`, touched-file Biome, dependency-cruiser, focused automation/Loop/adapter suites, and `git diff --check`; expect zero failures.**

- [ ] **Step 5: Run `npm run verify:local`; expect exit 0.**

- [ ] **Step 6: Review the complete diff against the design spec, amend only the relevant implementation commits if needed, and leave the worktree clean.**

## Self-review result

- Every design goal maps to a task: Batch retirement (1–2), persisted timing and coalescing (3), activity/capacity policy (4), two-stage enforcement and settlement (5), operator visibility (6), alignment/verification (7).
- The implementation never introduces human impersonation, direct model APIs, provider SDKs, queue priority, force bypass, or dynamic host wake behavior.
- `Schedule`, `AutomationIntent`, `AgentCapacityView`, occurrence status, and capacity-state names are consistent across tasks.
- No placeholder/TODO implementation step remains; risky state transitions have explicit RED tests and fail-safe outcomes.
