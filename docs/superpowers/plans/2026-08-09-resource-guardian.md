# Resource Guardian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a machine-wide Resource Guardian that detects sustained CPU pressure, closes background automation admission before new work is reserved, safely reduces strongly bot-owned load, records bounded evidence, and delegates at most one repair after stable recovery.

**Architecture:** A deep `resource-guardian` module owns pressure policy, sampling, circuit persistence, admission, ownership evidence, actions, and repair eligibility behind three external interfaces: `startResourceGuardian`, `admitResourceWork`, and `readResourceGuardianView`. Loop and Batch consume admission before reservation; Daily Task Audit, Runtime Guardian repair, Project Recovery, and Autopilot consume it through `startActiveDelegatedTask`. Runtime Guardian remains responsible for runtime-artifact findings; Resource Guardian only reuses its configured bot-repair repository target at composition time.

**Tech Stack:** TypeScript, Node.js `os`/`child_process`, Vitest, Commander, tmux, existing `JsonMapStore`/atomic-write helpers, Notification Gateway, Repair Coordinator, and WorkOrder supervision.

---

## Implementation Rules

- Execute each task as an independent slice on `dev`, preserving unrelated user changes.
- Use CodeGraph before locating or reading code not already named in this plan.
- Use `apply_patch` for edits and `rtk` for git, test, build, and search commands.
- Keep Resource Guardian disabled by default. Enable only observe mode on the operator installation after all local verification passes.
- Never signal a process from command name, CPU percentage, or working directory alone.
- Run focused tests after every green step and commit only the files listed for that task.
- Before any automation-facing implementation, re-read `docs/automation-alignment.md` and keep its affected surfaces aligned in the same slice.

## File Map

### New core module files

- `src/core/resource-guardian/types.ts` — canonical pressure, circuit, admission, incident, process, and view types.
- `src/core/resource-guardian/pressure-policy.ts` — pure sustained-pressure and recovery state machine.
- `src/core/resource-guardian/sampler.ts` — lightweight CPU/load/event-loop sampling and pressure-triggered deep probe adapter.
- `src/core/resource-guardian/store.ts` — atomic circuit/current-state persistence, corrupt-state quarantine, bounded incident retention.
- `src/core/resource-guardian/admission.ts` — shared allow/defer decision with no scheduling side effects.
- `src/core/resource-guardian/service.ts` — serialized tick coordinator and startup/stop interface.
- `src/core/resource-guardian/ownership.ts` — process ancestry plus tmux/WorkOrder/lease ownership proof.
- `src/core/resource-guardian/actions.ts` — deterministic cleanup, cooperative cancellation, grace period, and signal escalation.
- `src/core/resource-guardian/repair.ts` — stable-recovery eligibility, Repair Coordinator enqueue, and one-at-a-time WorkOrder dispatch.
- `src/core/resource-guardian/command.ts` — status/incidents/mode/profile command behavior.
- `src/cli/resource-commands.ts` — Commander registration only.

### New tests

- `tests/resource-guardian/pressure-policy.test.ts`
- `tests/resource-guardian/sampler.test.ts`
- `tests/resource-guardian/store-admission.test.ts`
- `tests/resource-guardian/service.test.ts`
- `tests/resource-guardian/ownership.test.ts`
- `tests/resource-guardian/actions.test.ts`
- `tests/resource-guardian/repair.test.ts`
- `tests/resource-guardian/command.test.ts`
- `tests/cli/resource-commands.test.ts`

### Existing files changed by integration

- `src/shared/types.ts`, `src/shared/config.ts`, `.env.example`
- `src/index.ts`
- `src/core/notifications/gateway.ts`, `src/core/notifications/events.ts`
- `src/core/autopilot/delegated-task.ts`
- `src/core/tasks/daily-audit-service.ts`
- `src/core/tasks/project-recovery-dispatch.ts`
- `src/core/runtime-guardian/service.ts`
- `src/core/loop/service.ts`
- `src/core/scheduler/scheduler.ts`, `src/core/scheduler/scheduler-loop.ts`
- `src/core/infra/system-load.ts`
- `src/adapters/control/operations-diagnostics.ts`
- `src/adapters/telegram/handlers.ts`, `src/adapters/lark/views.ts`
- `src/cli.ts`
- `src/core/prompts/types.ts`, `src/core/prompts/registry.ts`, `src/core/prompts/repair-prompts.ts`, `src/core/prompts/command.ts`
- `.gitignore`
- `docs/intelligent-automation.md`, `docs/automation-alignment.md`, `docs/automation-capability-matrix.md`, `docs/agent-maintenance-guidelines.md`, `docs/prompt-governance.md`, `docs/commands.md`, `docs/manual.md`
- Focused existing tests named in the tasks below.

## Task 1: Pure Pressure State Machine

**Files:**

- Create: `src/core/resource-guardian/types.ts`
- Create: `src/core/resource-guardian/pressure-policy.ts`
- Create: `tests/resource-guardian/pressure-policy.test.ts`

- [ ] **Step 1: Write failing transition and hysteresis tests**

Create tests that advance a fake clock through short bursts, sustained critical
pressure, emergency pressure, interrupted recovery, and stable recovery:

```ts
import { describe, expect, it } from "vitest";
import { advancePressureState, initialPressureMemory } from "../../src/core/resource-guardian/pressure-policy.js";
import type { ResourceSample } from "../../src/core/resource-guardian/types.js";

const sample = (capturedAt: number, hostCpuPct: number): ResourceSample => ({
  capturedAt,
  hostCpuPct,
  loadPct: hostCpuPct,
  eventLoopLagMs: 0,
  thermal: "normal",
});

describe("resource pressure policy", () => {
  it("ignores a CPU burst shorter than the elevated sustain window", () => {
    let state = initialPressureMemory(0);
    state = advancePressureState(state, sample(15_000, 95), "balanced");
    state = advancePressureState(state, sample(30_000, 95), "balanced");
    state = advancePressureState(state, sample(45_000, 20), "balanced");
    expect(state.pressure).toBe("healthy");
  });

  it("closes through critical and reopens only after ten stable minutes", () => {
    let state = initialPressureMemory(0);
    for (let now = 15_000; now <= 120_000; now += 15_000) {
      state = advancePressureState(state, sample(now, 94), "balanced");
    }
    expect(state.pressure).toBe("critical");
    for (let now = 135_000; now < 435_000; now += 15_000) {
      state = advancePressureState(state, sample(now, 50), "balanced");
    }
    expect(state.pressure).toBe("critical");
    state = advancePressureState(state, sample(435_000, 50), "balanced");
    expect(state.pressure).toBe("recovering");
    for (let now = 450_000; now < 735_000; now += 15_000) {
      state = advancePressureState(state, sample(now, 50), "balanced");
    }
    state = advancePressureState(state, sample(735_000, 50), "balanced");
    expect(state.pressure).toBe("healthy");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
rtk npx vitest run tests/resource-guardian/pressure-policy.test.ts
```

Expected: FAIL because the resource-guardian types and policy do not exist.

- [ ] **Step 3: Define canonical types and coherent profiles**

Add these public types to `types.ts`:

```ts
export type ResourceGuardianMode = "observe" | "protect";
export type ResourceGuardianProfile = "balanced" | "conservative";
export type PressureState = "healthy" | "elevated" | "critical" | "emergency" | "recovering";
export type ThermalPressure = "normal" | "pressure" | "unknown";

export type ResourceSample = {
  capturedAt: number;
  hostCpuPct: number;
  loadPct: number;
  eventLoopLagMs: number;
  thermal: ThermalPressure;
};

export type PressureMemory = {
  pressure: PressureState;
  stateSince: number;
  elevatedSince: number | null;
  criticalSince: number | null;
  emergencySince: number | null;
  thermalSince: number | null;
  recoverySince: number | null;
};

export type PressureProfile = {
  elevatedCpuPct: number;
  elevatedSustainMs: number;
  criticalCpuPct: number;
  criticalSustainMs: number;
  emergencyCpuPct: number;
  emergencySustainMs: number;
  thermalSustainMs: number;
  recoveryCpuPct: number;
  recoveringAfterMs: number;
  healthyAfterMs: number;
};
```

Use balanced thresholds `80/60s`, `92/90s`, `97/180s`, recovery below `65`,
recovering after five minutes, healthy after ten minutes. Conservative uses
`75/60s`, `88/90s`, `95/180s`, and recovery below `55`.

Define the profiles as one exported immutable catalog:

```ts
export const PRESSURE_PROFILES: Record<ResourceGuardianProfile, PressureProfile> = {
  balanced: {
    elevatedCpuPct: 80,
    elevatedSustainMs: 60_000,
    criticalCpuPct: 92,
    criticalSustainMs: 90_000,
    emergencyCpuPct: 97,
    emergencySustainMs: 180_000,
    thermalSustainMs: 15_000,
    recoveryCpuPct: 65,
    recoveringAfterMs: 300_000,
    healthyAfterMs: 600_000,
  },
  conservative: {
    elevatedCpuPct: 75,
    elevatedSustainMs: 60_000,
    criticalCpuPct: 88,
    criticalSustainMs: 90_000,
    emergencyCpuPct: 95,
    emergencySustainMs: 180_000,
    thermalSustainMs: 15_000,
    recoveryCpuPct: 55,
    recoveringAfterMs: 300_000,
    healthyAfterMs: 600_000,
  },
};
```

- [ ] **Step 4: Implement the pure transition function**

Implement independent sustained timestamps so a 97% sample can become critical
at 90 seconds before it becomes emergency at 180 seconds:

```ts
function transition(
  memory: PressureMemory,
  pressure: PressureState,
  now: number,
  recoverySince: number | null,
): PressureMemory {
  if (pressure === "healthy") return initialPressureMemory(now);
  return {
    ...memory,
    pressure,
    stateSince: memory.pressure === pressure ? memory.stateSince : now,
    recoverySince,
  };
}

export function initialPressureMemory(now: number): PressureMemory {
  return {
    pressure: "healthy",
    stateSince: now,
    elevatedSince: null,
    criticalSince: null,
    emergencySince: null,
    thermalSince: null,
    recoverySince: null,
  };
}

export function advancePressureState(
  previous: PressureMemory,
  sample: ResourceSample,
  profileName: ResourceGuardianProfile,
): PressureMemory {
  const profile = PRESSURE_PROFILES[profileName];
  const now = sample.capturedAt;
  const next = {
    ...previous,
    elevatedSince: sample.hostCpuPct >= profile.elevatedCpuPct ? previous.elevatedSince ?? now : null,
    criticalSince: sample.hostCpuPct >= profile.criticalCpuPct ? previous.criticalSince ?? now : null,
    emergencySince: sample.hostCpuPct >= profile.emergencyCpuPct ? previous.emergencySince ?? now : null,
    thermalSince: sample.thermal === "pressure" ? previous.thermalSince ?? now : null,
  };
  const sustained = (since: number | null, duration: number): boolean =>
    since !== null && now - since >= duration;
  const emergency =
    sustained(next.emergencySince, profile.emergencySustainMs) ||
    sustained(next.thermalSince, profile.thermalSustainMs);
  const critical = sustained(next.criticalSince, profile.criticalSustainMs);
  const elevated = sustained(next.elevatedSince, profile.elevatedSustainMs);

  if (emergency) return transition(next, "emergency", now, null);
  if (critical) return transition(next, "critical", now, null);
  if (elevated && previous.pressure === "healthy") return transition(next, "elevated", now, null);
  if (previous.pressure === "elevated" && !elevated)
    return transition(next, "healthy", now, null);

  if (
    (previous.pressure === "critical" ||
      previous.pressure === "emergency" ||
      previous.pressure === "recovering") &&
    sample.hostCpuPct < profile.recoveryCpuPct
  ) {
    const recoverySince = previous.recoverySince ?? now;
    if (now - recoverySince >= profile.healthyAfterMs)
      return transition({ ...next, recoverySince }, "healthy", now, null);
    if (now - recoverySince >= profile.recoveringAfterMs)
      return transition({ ...next, recoverySince }, "recovering", now, recoverySince);
    return { ...next, recoverySince };
  }
  return { ...next, recoverySince: null };
}
```

`transition` must preserve `stateSince` when the state is unchanged and reset
all sustained timestamps when returning to healthy.

- [ ] **Step 5: Run focused tests and commit**

```bash
rtk npx vitest run tests/resource-guardian/pressure-policy.test.ts
rtk git add src/core/resource-guardian/types.ts src/core/resource-guardian/pressure-policy.ts tests/resource-guardian/pressure-policy.test.ts
rtk git commit -m "feat(resource): add sustained pressure policy"
```

Expected: focused tests pass; commit contains only the pure model.

## Task 2: Lightweight Sampler and Manual Snapshot Reuse

**Files:**

- Create: `src/core/resource-guardian/sampler.ts`
- Create: `tests/resource-guardian/sampler.test.ts`
- Modify: `src/core/resource-guardian/types.ts`
- Modify: `src/core/infra/system-load.ts:7-164`
- Modify: `tests/core/system-load.test.ts`

- [ ] **Step 1: Write failing CPU-delta and deep-probe gating tests**

Test aggregate CPU deltas rather than load average:

```ts
it("normalizes CPU time deltas to a host busy percentage", () => {
  expect(hostCpuBusyPct({ idle: 100, total: 400 }, { idle: 120, total: 500 })).toBe(80);
});

it("does not run the deep probe for healthy lightweight samples", async () => {
  const deep = vi.fn(async () => ({ processes: [], thermal: "normal" as const }));
  const sampler = createResourceSampler(fakeLightweightProbe([20, 25]), deep);
  await sampler.sample({ now: 15_000, scheduledAt: 15_000, deep: false });
  expect(deep).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and observe the missing-module failure**

```bash
rtk npx vitest run tests/resource-guardian/sampler.test.ts tests/core/system-load.test.ts
```

- [ ] **Step 3: Implement CPU time aggregation and sampling adapters**

Use explicit adapters so tests never execute `top`, `ps`, or `pmset`:

```ts
export type CpuTotals = { idle: number; total: number };
export type ResourceProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  startedAt: string;
  cpuPct: number;
  rssKb: number;
  command: string;
  cwd?: string;
};
export type DeepResourceSnapshot = {
  capturedAt: number;
  thermal: ThermalPressure;
  processes: ResourceProcess[];
};
export type LightweightProbe = {
  cpuTotals(): CpuTotals;
  loadAverage(): readonly [number, number, number];
  cpuCount(): number;
};
export type DeepResourceProbe = () => Promise<DeepResourceSnapshot>;

export function hostCpuBusyPct(previous: CpuTotals, current: CpuTotals): number {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 100)));
}
```

The production lightweight probe uses `os.cpus()` and `os.loadavg()`. The
sampler retains the previous CPU totals internally. Its first sample reports
`hostCpuPct: 0` and becomes baseline-only. Event-loop lag is
`Math.max(0, now - scheduledAt)`.

- [ ] **Step 4: Reuse normalized types in the manual system-load module**

Keep `gatherSystemLoad` backward compatible, but add `hostCpuPct` when a previous
CPU snapshot is supplied. Do not start a repeating deep probe from
`system-load.ts`; manual sysload remains an explicit expensive diagnostic.

- [ ] **Step 5: Verify and commit**

```bash
rtk npx vitest run tests/resource-guardian/sampler.test.ts tests/core/system-load.test.ts
rtk git add src/core/resource-guardian/types.ts src/core/resource-guardian/sampler.ts tests/resource-guardian/sampler.test.ts src/core/infra/system-load.ts tests/core/system-load.test.ts
rtk git commit -m "feat(resource): add lightweight machine sampler"
```

## Task 3: Durable Circuit, Incident Retention, and Admission

**Files:**

- Create: `src/core/resource-guardian/store.ts`
- Create: `src/core/resource-guardian/admission.ts`
- Create: `tests/resource-guardian/store-admission.test.ts`
- Modify: `src/core/resource-guardian/types.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing store, corruption, and admission tests**

Cover cross-process reads by changing the circuit file between two admissions:

```ts
it("denies background-heavy work from a closed circuit without creating state", () => {
  writeCircuit({
    schemaVersion: 1,
    pressure: "critical",
    incidentId: "incident-1",
    admission: "background-closed",
    reason: "sustained host CPU 94%",
    changedAt: 100,
    lastSampleAt: 100,
    owner: "resource-guardian",
  });
  expect(admitResourceWork({
    source: "loop-engineering",
    trigger: "background",
    weight: "heavy",
    now: 101,
  })).toEqual({
    allowed: false,
    reason: "sustained host CPU 94%",
    incidentId: "incident-1",
  });
});

it("never lets force bypass emergency", () => {
  writeCircuit(emergencyCircuit());
  expect(admitResourceWork({
    source: "autopilot-delegate",
    trigger: "operator",
    weight: "heavy",
    forced: true,
    now: 101,
  }).allowed).toBe(false);
});
```

Also test absent state, observe mode, reconcile-class work, corrupt-state
quarantine, newest-50 retention, and the 10 MiB total cap.

- [ ] **Step 2: Run and observe failure**

```bash
rtk npx vitest run tests/resource-guardian/store-admission.test.ts
```

- [ ] **Step 3: Add circuit and admission types**

```ts
export type ResourceCircuitState = {
  schemaVersion: 1;
  pressure: PressureState;
  incidentId: string | null;
  admission: "open" | "heavy-closed" | "background-closed";
  reason: string;
  changedAt: number;
  lastSampleAt: number;
  owner: "resource-guardian";
};

export type ResourceAdmissionInput = {
  source:
    | "loop-engineering"
    | "daily-task-audit"
    | "runtime-guardian"
    | "project-recovery"
    | "autopilot-delegate"
    | "batch-scheduler"
    | "resource-guardian";
  trigger: "interactive" | "operator" | "background" | "reconcile" | "resource-repair";
  weight: "light" | "heavy";
  now: number;
  forced?: boolean;
};

export type ResourceAdmission =
  | { allowed: true; reason: string; incidentId: string | null }
  | { allowed: false; reason: string; incidentId: string | null };

export type ResourceIncident = {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  attribution: "bot-owned" | "external" | "unknown";
  startedAt: number;
  endedAt?: number;
  pressure: PressureState;
  samples: ResourceSample[];
  transitions: Array<{ from: PressureState; to: PressureState; at: number }>;
  actions: Array<{ kind: string; at: number; outcome: string; reason: string }>;
  repairWorkOrderId?: string;
};

export type ResourceGuardianView = {
  enabled: boolean;
  mode: ResourceGuardianMode;
  profile: ResourceGuardianProfile;
  pressure: PressureState;
  circuit: ResourceCircuitState["admission"];
  incidentId: string | null;
  reason: string;
  attribution: ResourceIncident["attribution"];
  latestSample: ResourceSample | null;
};

export type ResourceGuardianOperatorState = {
  schemaVersion: 1;
  mode: ResourceGuardianMode;
  profile: ResourceGuardianProfile;
  updatedAt: number;
};
```

- [ ] **Step 4: Implement atomic store and bounded incident retention**

Store current state at `state/resource-guardian/state.json` and incidents under
`state/resource-guardian/incidents/`. Use `writeFileAtomicSync`. On invalid JSON
or schema, rename the source to `state.json.corrupt-<epoch>` and return a
degraded observe view; do not overwrite the corrupt bytes.

Store live operator mode/profile override at
`state/resource-guardian/operator.json`. It is small, atomic, and read on every
tick so `tcb resource mode/profile` affects the running bot without waiting for
a restart. The command also persists the matching environment values for the
next process start.

Retention order is `endedAt ?? startedAt`, then id. Delete oldest files until
both count `<= 50` and total regular-file size `<= 10 * 1024 * 1024`.

- [ ] **Step 5: Implement pure admission mapping over the current circuit**

```ts
export function admitFromCircuit(
  input: ResourceAdmissionInput,
  circuit: ResourceCircuitState,
): ResourceAdmission {
  if (input.trigger === "interactive" || input.trigger === "reconcile")
    return { allowed: true, reason: "interactive or reconciliation work", incidentId: circuit.incidentId };
  if (circuit.admission === "open")
    return { allowed: true, reason: "resource circuit is open", incidentId: circuit.incidentId };
  if (circuit.pressure === "emergency")
    return { allowed: false, reason: circuit.reason, incidentId: circuit.incidentId };
  if (input.trigger === "operator" && input.forced === true)
    return { allowed: true, reason: "operator forced under non-emergency pressure", incidentId: circuit.incidentId };
  if (circuit.admission === "heavy-closed" && input.weight === "light")
    return { allowed: true, reason: "light work allowed during elevated pressure", incidentId: circuit.incidentId };
  return { allowed: false, reason: circuit.reason, incidentId: circuit.incidentId };
}
```

`admitResourceWork` reads the current state and delegates to this pure function.
It performs no write and never increments an attempt.

- [ ] **Step 6: Ignore runtime evidence and commit**

Add `/state/resource-guardian/` to `.gitignore`, then run:

```bash
rtk npx vitest run tests/resource-guardian/store-admission.test.ts
rtk git add src/core/resource-guardian/types.ts src/core/resource-guardian/store.ts src/core/resource-guardian/admission.ts tests/resource-guardian/store-admission.test.ts .gitignore
rtk git commit -m "feat(resource): add runtime circuit and admission"
```

## Task 4: Observe-Mode Coordinator, Configuration, Startup, and Notifications

**Files:**

- Create: `src/core/resource-guardian/service.ts`
- Create: `tests/resource-guardian/service.test.ts`
- Modify: `src/shared/types.ts:10-117`
- Modify: `src/shared/config.ts:134-166,299-415`
- Modify: `.env.example:127-158`
- Modify: `src/core/notifications/gateway.ts:10-20`
- Modify: `src/core/notifications/events.ts`
- Modify: `src/index.ts:1-24,146-179`
- Modify: `tests/config.test.ts`
- Modify: `tests/alignment-governance-contract.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Test serialized ticks, observe mode keeping admission open, protect mode closing
it, transition-only notification, sampling failure, restart from a recent closed
circuit, and the 15-minute stale safety hold.

```ts
it("records critical pressure in observe mode without closing admission", async () => {
  const store = new InMemoryResourceGuardianStore();
  const notify = vi.fn(async () => ({ status: "sent", deliveries: [] }));
  const result = await runResourceGuardianTick({
    now: 120_000,
    config: { enabled: true, mode: "observe", profile: "balanced", tickMs: 15_000 },
    store,
    sample: async () => criticalSample(120_000),
    notify,
  });
  expect(result.pressure).toBe("critical");
  expect(store.readCircuit().admission).toBe("open");
});
```

- [ ] **Step 2: Run and observe failure**

```bash
rtk npx vitest run tests/resource-guardian/service.test.ts tests/config.test.ts
```

- [ ] **Step 3: Add configuration without enabling existing installations**

Add to `AppConfig`:

```ts
resourceGuardian: {
  enabled: boolean;
  mode: ResourceGuardianMode;
  profile: ResourceGuardianProfile;
  tickMs: number;
};
```

Add schema/defaults:

```text
RESOURCE_GUARDIAN_ENABLED=false
RESOURCE_GUARDIAN_MODE=observe
RESOURCE_GUARDIAN_PROFILE=balanced
RESOURCE_GUARDIAN_TICK_MS=15000
```

Parse only `observe|protect` and `balanced|conservative`; reject invalid values.

- [ ] **Step 4: Implement one serialized tick and startup timer**

`runResourceGuardianTick` must:

1. return disabled without sampling when disabled or `tickMs === 0`;
2. resolve effective mode/profile from the live operator state, falling back to
   loaded configuration;
3. sample and advance the pure policy;
4. create/reuse one incident id for a continuous non-healthy episode;
5. write `open` in observe mode;
6. write `heavy-closed` for elevated and `background-closed` for critical,
   emergency, and recovering in protect mode;
7. append one transition entry and notify only when state changes;
8. never overlap ticks.

`startResourceGuardian` returns a stop function and calls one initial tick only
after Notification Gateway senders are ready.

- [ ] **Step 5: Add notification catalog and event rendering**

Add `resource-guardian` to `NOTIFICATION_SOURCE_CATALOG`. Add a
`resource.pressure-transition` event with old/new state, incident id, CPU,
circuit, and action summary. Render through `notificationRequestForEvent` so
Telegram and Lark receive identical semantics.

- [ ] **Step 6: Wire startup after notification readiness**

Import `startResourceGuardian` in `src/index.ts` and call it before Runtime
Guardian and Daily Task Audit inside `startNotificationDrivenServices`. Do not
start it beside the pre-notification scheduler block.

- [ ] **Step 7: Verify and commit**

```bash
rtk npx vitest run tests/resource-guardian/service.test.ts tests/config.test.ts tests/alignment-governance-contract.test.ts
rtk npm run lint:types
rtk git add src/core/resource-guardian/service.ts tests/resource-guardian/service.test.ts src/shared/types.ts src/shared/config.ts .env.example src/core/notifications/gateway.ts src/core/notifications/events.ts src/index.ts tests/config.test.ts tests/alignment-governance-contract.test.ts
rtk git commit -m "feat(resource): start observe-mode guardian"
```

## Task 5: Gate Active Delegation and Repair Producers

**Files:**

- Modify: `src/core/autopilot/delegated-task.ts:270-444`
- Modify: `src/core/tasks/daily-audit-service.ts:496-523`
- Modify: `src/core/tasks/project-recovery-dispatch.ts:63-68`
- Modify: `src/core/runtime-guardian/service.ts:275-328`
- Modify: `tests/autopilot/delegated-task-supervisor-pool.test.ts`
- Modify: `tests/tasks/daily-audit-service.test.ts`
- Modify: `tests/runtime-guardian/service.test.ts`

- [ ] **Step 1: Write a failing no-side-effect delegation test**

Write a critical circuit into a temporary `TCB_STATE_DIR`, then call
`startActiveDelegatedTask` with `resourceTrigger: "background"`. Assert the
result is blocked and `startLoopSupervisor`, WorkOrder state, task ledger, and
worker lease remain untouched.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
rtk npx vitest run tests/autopilot/delegated-task-supervisor-pool.test.ts
```

- [ ] **Step 3: Add trigger metadata and admit before reservation**

Extend only the input object:

```ts
resourceTrigger?: "operator" | "background" | "resource-repair";
resourceForce?: boolean;
```

Immediately after the supervisor-enabled check and before path lookup or
`startingActiveDelegationProjects.add`, call:

```ts
const admission = admitResourceWork({
  source: "autopilot-delegate",
  trigger: input.resourceTrigger ?? "operator",
  weight: "heavy",
  forced: input.resourceForce,
  now: Date.now(),
});
if (!admission.allowed) {
  return {
    status: "blocked",
    reason: `resource admission deferred: ${admission.reason}`,
    showQueue: false,
  };
}
```

Interactive Telegram, Lark, and Control callers retain the default `operator`.

- [ ] **Step 4: Mark every automated producer as background**

Pass `resourceTrigger: "background"` from Daily Task Audit repair, Runtime
Guardian repair, and `createProjectRecoveryDelegator`. Do not add duplicate
admission checks in those modules; `startActiveDelegatedTask` is authoritative.

- [ ] **Step 5: Verify producer behavior and commit**

```bash
rtk npx vitest run tests/autopilot/delegated-task-supervisor-pool.test.ts tests/tasks/daily-audit-service.test.ts tests/runtime-guardian/service.test.ts
rtk git add src/core/autopilot/delegated-task.ts src/core/tasks/daily-audit-service.ts src/core/tasks/project-recovery-dispatch.ts src/core/runtime-guardian/service.ts tests/autopilot/delegated-task-supervisor-pool.test.ts tests/tasks/daily-audit-service.test.ts tests/runtime-guardian/service.test.ts
rtk git commit -m "feat(resource): gate delegated background work"
```

## Task 6: Gate Loop and Batch Before Durable Reservation

**Files:**

- Modify: `src/core/loop/service.ts:108-113,326-1115`
- Modify: `tests/loop/service-supervisor.test.ts`
- Modify: `tests/loop/service.test.ts`
- Modify: `src/core/scheduler/scheduler.ts:10-35`
- Modify: `src/core/scheduler/scheduler-loop.ts:19-53,260-266,401-427`
- Modify: `tests/scheduler/scheduler.test.ts`
- Modify: `tests/scheduler/scheduler-loop.test.ts`
- Modify: `tests/scheduler/start-scheduler.test.ts`

- [ ] **Step 1: Write a failing Loop deferral test**

With a due agent-supervised project and critical circuit, call
`runLoopServiceTickAsync`. Assert:

```ts
expect(runSupervisorTask).not.toHaveBeenCalled();
expect(listUnfinishedLoopSupervisorWorkOrders()).toEqual([]);
expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([]);
expect(schedulerStore.getLastFired("project-a:architecture")).toBeUndefined();
expect(new DailyTaskLedger().listAll()).toEqual([]);
```

The due occurrence remains due; resource pressure does not become a task
failure or consume a retry.

- [ ] **Step 2: Write a failing Batch first-admission test**

Add `isGated` to the `reconcile` test context and prove a queued task remains
queued when gated. Existing `resumeUngatedTasks` coverage is insufficient
because it does not prevent the first queued-to-running transition.

- [ ] **Step 3: Run both focused suites and observe failure**

```bash
rtk npx vitest run tests/loop/service-supervisor.test.ts tests/scheduler/scheduler.test.ts tests/scheduler/scheduler-loop.test.ts
```

- [ ] **Step 4: Gate Loop before `beginLedger` and buffer reservation**

For each due target, call `admitResourceWork` before pushing it into
`supervisedBuffer` or invoking `runSystemDue`. On denial, log one structured
defer record with job key and incident id, then continue without calling
`recordDueTargetWithoutDispatch`; that helper advances scheduler state and is
therefore incorrect for transient resource deferral.

- [ ] **Step 5: Make Batch `reconcile` honor its gate before admission**

Extend `ReconcileDeps`:

```ts
isGated?: (session: string) => boolean;
```

Filter the result of `tasksToAdmit` before mapping tasks to running:

```ts
const admit = tasksToAdmit(run.tasks, caps, pools).filter((task) => {
  const session = deps.resolveSession(task);
  return deps.isGated?.(session) !== true;
});
```

Pass `ctx.isGated` from `schedulerTick`. In `startScheduler`, replace
`isGated: () => false` with a read-only Resource Guardian admission for
`batch-scheduler/background/heavy`. Reconciliation of already-running tasks
continues while admission is closed.

- [ ] **Step 6: Verify and commit**

```bash
rtk npx vitest run tests/loop/service-supervisor.test.ts tests/loop/service.test.ts tests/scheduler/scheduler.test.ts tests/scheduler/scheduler-loop.test.ts tests/scheduler/start-scheduler.test.ts
rtk git add src/core/loop/service.ts tests/loop/service-supervisor.test.ts tests/loop/service.test.ts src/core/scheduler/scheduler.ts src/core/scheduler/scheduler-loop.ts tests/scheduler/scheduler.test.ts tests/scheduler/scheduler-loop.test.ts tests/scheduler/start-scheduler.test.ts
rtk git commit -m "feat(resource): gate loop and batch admission"
```

## Task 7: Strong Process Ownership Evidence

**Files:**

- Create: `src/core/resource-guardian/ownership.ts`
- Create: `tests/resource-guardian/ownership.test.ts`
- Modify: `src/core/resource-guardian/types.ts`

- [ ] **Step 1: Write failing process-tree and PID-reuse tests**

Use synthetic process rows and durable resource records:

```ts
it("classifies a descendant of a leased worker pane as bot-active", () => {
  const result = resolveProcessOwnership({
    process: proc(300, 200, "start-300", 180),
    processes: [proc(200, 1, "start-200", 0), proc(300, 200, "start-300", 180)],
    panes: [{ session: "tmux_proj_loop-worker-a", pid: 200 }],
    workOrders: [activeWorkOrder("run-a", "tmux_proj_loop-worker-a")],
    leases: [activeLease("run-a", "tmux_proj_loop-worker-a")],
  });
  expect(result.classification).toBe("bot-active");
  expect(result.strong).toBe(true);
});

it("refuses an action when PID start time changed", () => {
  expect(sameProcessInstance(proc(300, 1, "old", 90), proc(300, 1, "new", 90))).toBe(false);
});
```

Also test external process, unknown automation-looking command, terminal
WorkOrder, stale lease, contradictory session evidence, and multiple descendants.

- [ ] **Step 2: Run and observe failure**

```bash
rtk npx vitest run tests/resource-guardian/ownership.test.ts
```

- [ ] **Step 3: Define process and evidence types**

```ts
export type ProcessOwnership = {
  classification: "external" | "unknown" | "bot-active" | "bot-terminal" | "bot-stale";
  strong: boolean;
  process: ResourceProcess;
  session?: string;
  workOrderId?: string;
  leaseId?: string;
  evidence: string[];
};
```

- [ ] **Step 4: Implement ancestry and durable correlation**

Build one parent-to-children index per deep sample. Reuse
`configResolver.panePid(session)` for named automation sessions and read active
WorkOrders/leases through existing registry modules. Strong ownership requires
matching process instance plus either bot launch ancestry or pane ancestry with
matching durable WorkOrder/lease evidence.

The production process adapter uses one bulk `ps` command. Resolve `cwd` only
for shortlisted candidates. Do not call `lsof` for every process.

- [ ] **Step 5: Verify and commit**

```bash
rtk npx vitest run tests/resource-guardian/ownership.test.ts tests/takeover.test.ts tests/agent-config-resolver.test.ts
rtk git add src/core/resource-guardian/types.ts src/core/resource-guardian/ownership.ts tests/resource-guardian/ownership.test.ts
rtk git commit -m "feat(resource): prove bot process ownership"
```

## Task 8: Deterministic Cleanup and Cooperative Preemption

**Files:**

- Create: `src/core/resource-guardian/actions.ts`
- Create: `tests/resource-guardian/actions.test.ts`
- Modify: `src/core/autopilot/delegated-task.ts:198-268,914-930`
- Modify: `tests/autopilot/delegated-task-supervisor-pool.test.ts`
- Modify: `src/core/resource-guardian/service.ts`

- [ ] **Step 1: Write failing action-order tests**

Assert the exact order: close circuit, reconcile terminal resources, cancel
active work, re-sample, revalidate PID/start time, SIGTERM, then SIGKILL only
for terminal/stale ownership.

```ts
expect(actions).toEqual([
  "circuit:background-closed",
  "reconcile:terminal-resources",
  "cancel:run-a:resource-pressure",
  "resample",
]);
expect(signal).not.toHaveBeenCalled();
```

Add negative cases for external, unknown, changed start time, active work after
grace period, and cleanup failure.

- [ ] **Step 2: Generalize cooperative cancellation reason**

Extend `cancelActiveDelegatedTaskByRunId` input with an optional reason:

```ts
input: { runId: string; reason?: "user" | "resource-pressure" }
```

Map it to `cancelled by user` or `cancelled by resource pressure` for the
AbortController and `revisionReasons`. Preserve current adapter behavior by
defaulting to `user`.

- [ ] **Step 3: Implement deterministic action selection**

`planResourceActions` is pure and returns actions; `executeResourceActions`
performs them. Terminal/stale cleanup calls
`reconcileTerminalSupervisorResources` and the existing worker-session cleanup
interface. Active contribution is ranked by normalized bot CPU, then lower task
priority, then oldest start time.

Only a strongly owned process that remains the same instance may receive a
signal. `SIGKILL` requires terminal/stale classification after a completed
SIGTERM grace period; active work never jumps directly to SIGKILL.

- [ ] **Step 4: Invoke actions only in protect-mode emergency**

Observe mode records the proposed actions but executes none. Elevated and
critical close admission but do not signal. Emergency invokes one action pass
per incident transition and then rate-limits additional passes to 30 seconds.

- [ ] **Step 5: Verify and commit**

```bash
rtk npx vitest run tests/resource-guardian/actions.test.ts tests/autopilot/delegated-task-supervisor-pool.test.ts tests/loop/supervisor-resource-reconciliation.test.ts
rtk git add src/core/resource-guardian/actions.ts tests/resource-guardian/actions.test.ts src/core/autopilot/delegated-task.ts tests/autopilot/delegated-task-supervisor-pool.test.ts src/core/resource-guardian/service.ts
rtk git commit -m "feat(resource): safely reduce bot-owned load"
```

## Task 9: Stable Recovery and One-at-a-Time Agent Repair

**Files:**

- Create: `src/core/resource-guardian/repair.ts`
- Create: `tests/resource-guardian/repair.test.ts`
- Modify: `src/core/resource-guardian/service.ts`
- Modify: `src/core/prompts/types.ts`
- Modify: `src/core/prompts/registry.ts`
- Modify: `src/core/prompts/repair-prompts.ts`
- Modify: `src/core/prompts/command.ts`
- Modify: `tests/prompts/prompt-registry.test.ts`
- Modify: `tests/prompts/prompt-command.test.ts`
- Modify: `tests/prompts/repair-prompts.test.ts`
- Modify: `docs/prompt-governance.md`

- [ ] **Step 1: Write failing eligibility and dedupe tests**

Test that repair is blocked during pressure, before ten stable minutes, for an
external incident, when deterministic cleanup closed the incident, and when an
equivalent repair is active. Test one eligible incident enqueues one record and
dispatches one WorkOrder.

- [ ] **Step 2: Run and observe failure**

```bash
rtk npx vitest run tests/resource-guardian/repair.test.ts tests/prompts/repair-prompts.test.ts tests/prompts/prompt-registry.test.ts
```

- [ ] **Step 3: Implement pure repair eligibility**

```ts
export function resourceRepairEligibility(input: {
  incident: ResourceIncident;
  circuit: ResourceCircuitState;
  stableSince: number | null;
  now: number;
  activeRepairFingerprint: string | null;
}): { eligible: true; fingerprint: string } | { eligible: false; reason: string } {
  if (input.circuit.pressure !== "healthy")
    return { eligible: false, reason: "machine has not completed recovery" };
  if (input.stableSince === null || input.now - input.stableSince < 600_000)
    return { eligible: false, reason: "stable recovery window is incomplete" };
  if (input.incident.attribution !== "bot-owned")
    return { eligible: false, reason: "incident is not bot-owned" };
  const fingerprint = input.incident.fingerprint;
  if (input.activeRepairFingerprint === fingerprint)
    return { eligible: false, reason: "equivalent repair is active" };
  return { eligible: true, fingerprint };
}
```

- [ ] **Step 4: Reuse the configured bot-repair target without new personal config**

At composition time, use `deps.config.runtimeGuardian.repoPath || process.cwd()`
and `deps.config.runtimeGuardian.repairBranch` as the existing bot-repair
repository target. Verify its git toplevel before dispatch. Do not add a second
Resource Guardian repo path or branch setting.

Enqueue `source: "resource-guardian"` in the existing `RepairCoordinator`, then
call `startActiveDelegatedTask` with `resourceTrigger: "resource-repair"`.
Admission remains authoritative and global repair concurrency is one.

- [ ] **Step 5: Govern the repair prompt**

Add `repair.resource-guardian` to `GovernedPromptId` and the registry with
`actionScope: "commit"`, `evalExpectation: "contract-test"`, and owner
`src/core/resource-guardian/repair.ts`. Implement
`buildResourceGuardianRepairPrompt` with incident evidence, bot-repo-only scope,
no target-project edits, active-agent-only AI, `npm run verify:local`, and no PR.
Add a deterministic render fixture in `src/core/prompts/command.ts`.

- [ ] **Step 6: Verify and commit**

```bash
rtk npx vitest run tests/resource-guardian/repair.test.ts tests/prompts/repair-prompts.test.ts tests/prompts/prompt-registry.test.ts tests/prompts/prompt-command.test.ts
rtk git add src/core/resource-guardian/repair.ts tests/resource-guardian/repair.test.ts src/core/resource-guardian/service.ts src/core/prompts/types.ts src/core/prompts/registry.ts src/core/prompts/repair-prompts.ts src/core/prompts/command.ts tests/prompts/prompt-registry.test.ts tests/prompts/prompt-command.test.ts tests/prompts/repair-prompts.test.ts docs/prompt-governance.md
rtk git commit -m "feat(resource): repair stable bot-owned incidents"
```

## Task 10: Operator Commands, Diagnostics, Alignment, and Rollout

**Files:**

- Create: `src/core/resource-guardian/command.ts`
- Create: `src/cli/resource-commands.ts`
- Create: `tests/resource-guardian/command.test.ts`
- Create: `tests/cli/resource-commands.test.ts`
- Modify: `src/cli.ts:15-101,189-198`
- Modify: `src/core/infra/system-load.ts:118-145`
- Modify: `src/adapters/control/operations-diagnostics.ts`
- Modify: `src/adapters/telegram/handlers.ts`
- Modify: `src/adapters/lark/views.ts`
- Modify: `tests/core/system-load.test.ts`
- Modify: `tests/adapters/control/server-ops.test.ts`
- Modify: `src/core/config/config-command.ts`
- Modify: `tests/config-command.test.ts`
- Modify: `tests/alignment-governance-contract.test.ts`
- Modify: `docs/intelligent-automation.md`
- Modify: `docs/automation-alignment.md`
- Modify: `docs/automation-capability-matrix.md`
- Modify: `docs/agent-maintenance-guidelines.md`
- Modify: `docs/commands.md`
- Modify: `docs/manual.md`

- [ ] **Step 1: Write failing command-tree and rendering tests**

Assert the exact command tree:

```ts
expect(resource.commands.map((command) => command.name())).toEqual([
  "status",
  "incidents",
  "mode",
  "profile",
]);
```

Test JSON status, bounded incident limit, invalid mode/profile, atomic config
write, secret-free output, and home-path tildeification.

- [ ] **Step 2: Implement the dedicated operator command module**

Support:

```text
tcb resource status [--json]
tcb resource incidents [--limit N] [--json]
tcb resource mode observe|protect
tcb resource profile balanced|conservative
```

Mode/profile mutations use `writeConfigEnvironment` with fixed keys and write
the matching live `operator.json` override through `ResourceGuardianStore`.
`protect` must fail when Resource Guardian is disabled and explain that the
operator must enable it through the allowlisted config command first. Add
`RESOURCE_GUARDIAN_ENABLED` and `RESOURCE_GUARDIAN_TICK_MS` to the non-secret
generic config-set allowlist; mode/profile remain behind the dedicated resource
command. Reads never expose raw personal absolute paths.

- [ ] **Step 3: Register the command family in the CLI composition root**

Import and call `registerResourceCommands(program)` beside the existing
configuration and capability registration calls. Keep the existing standalone
`sysload` registration in the composition root; this slice changes its rendered
content but does not move or rename the public command.

- [ ] **Step 4: Add Guardian context to every existing sysload surface**

Extend `renderSystemLoad` with an optional `ResourceGuardianView`. Append:

```text
Resource Guardian: critical · background closed
Incident: <id>
Reason: sustained host CPU 94%
Attribution: bot-owned | external | unknown
```

Update CLI, Control diagnostics, Telegram, and Lark callers. Do not add a new
Control protocol operation or new chat button.

- [ ] **Step 5: Align documentation and contracts**

Document Resource Guardian as a distinct intent module, add
`resource-guardian` to the enforced bot-owned notification-source list, record
the admission invariant, document observe-to-protect rollout, commands,
incident retention, state-backup exclusion, and emergency override semantics.

Update capability matrix rows for CLI, existing sysload chat/control surfaces,
and notification parity. Keep examples synthetic and paths tildeified.

- [ ] **Step 6: Run focused interface verification**

```bash
rtk npx vitest run tests/resource-guardian tests/cli/resource-commands.test.ts tests/core/system-load.test.ts tests/adapters/control/server-ops.test.ts tests/config-command.test.ts tests/alignment-governance-contract.test.ts
rtk npm run lint:types
rtk npm run lint:types:tests
```

Expected: all Resource Guardian and affected contract tests pass.

- [ ] **Step 7: Run the full local gate**

```bash
rtk npm run verify:local
rtk git status --short --branch
```

Expected: `verify:local` exits 0 and only the intended Task 10 files are dirty.

- [ ] **Step 8: Commit the aligned operator surface**

```bash
rtk git add src/core/resource-guardian/command.ts src/cli/resource-commands.ts tests/resource-guardian/command.test.ts tests/cli/resource-commands.test.ts src/cli.ts src/core/infra/system-load.ts src/adapters/control/operations-diagnostics.ts src/adapters/telegram/handlers.ts src/adapters/lark/views.ts src/core/config/config-command.ts tests/core/system-load.test.ts tests/adapters/control/server-ops.test.ts tests/config-command.test.ts tests/alignment-governance-contract.test.ts docs/intelligent-automation.md docs/automation-alignment.md docs/automation-capability-matrix.md docs/agent-maintenance-guidelines.md docs/commands.md docs/manual.md
rtk git commit -m "feat(resource): expose protected resource operations"
```

## Task 11: Current-Machine Observe Rollout and Evidence Check

**Files:**

- Runtime config only: `~/.tmux-claude-bot/state/.env`
- Runtime evidence only: `~/.tmux-claude-bot/state/resource-guardian/`

- [ ] **Step 1: Confirm source and runtime repositories are clean and distinct**

```bash
rtk git status --short --branch
rtk git -C ~/.tmux-claude-bot/state status --short --branch
```

Expected: no unreviewed source changes; state repository does not track
`resource-guardian/`.

- [ ] **Step 2: Enable observe mode through safe commands**

```bash
node dist/cli.js config set RESOURCE_GUARDIAN_ENABLED true
node dist/cli.js resource mode observe
node dist/cli.js resource profile balanced
```

Restart the managed bot through its existing service command so the new
enablement config is loaded. Do not hand-edit runtime state.

- [ ] **Step 3: Verify the live diagnostic interface**

```bash
node dist/cli.js resource status --json
node dist/cli.js sysload
```

Expected: status is parseable JSON, mode is observe, circuit is open, and
sysload includes Resource Guardian context.

- [ ] **Step 4: Observe before enabling protection**

Leave observe mode running through representative idle, test, and background
automation periods. Review incidents with:

```bash
node dist/cli.js resource incidents --limit 20 --json
```

Promote to protect only when every recorded hot process has correct ownership,
short bursts remain non-incidents, normal overhead stays below 0.5% of one core,
and incident retention remains bounded. If any ownership is ambiguous, keep
observe mode and fix classification through a new regression test before
protect mode.

- [ ] **Step 5: Record rollout evidence without committing live configuration**

Add only generic lessons or contract changes to maintained documentation. Do
not commit the operator's live thresholds, paths, process ids, project list, or
incident files to the source repository.
