import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { notificationRequestForEvent } from "../../src/core/notifications/events.js";
import {
  createResourceGuardianCoordinator,
  type ResourceGuardianTickRuntime,
  runResourceGuardianTick,
  startResourceGuardian,
} from "../../src/core/resource-guardian/service.js";
import type {
  ResourceGuardianCurrentRead,
  ResourceGuardianCurrentState,
  ResourceGuardianStore,
} from "../../src/core/resource-guardian/store.js";
import type {
  ResourceCircuitState,
  ResourceGuardianOperatorState,
  ResourceGuardianView,
  ResourceIncident,
  ResourceSample,
} from "../../src/core/resource-guardian/types.js";
import type { AppConfig } from "../../src/shared/types.js";

const minute = 60_000;
type StartResourceGuardianTestOptions = NonNullable<Parameters<typeof startResourceGuardian>[1]>;

function sample(capturedAt: number, hostCpuPct: number): ResourceSample {
  return {
    capturedAt,
    hostCpuPct,
    loadPct: hostCpuPct,
    eventLoopLagMs: 0,
    thermal: "normal",
  };
}

function config(
  overrides: Partial<AppConfig["resourceGuardian"]> = {},
): AppConfig["resourceGuardian"] {
  return { enabled: true, mode: "observe", profile: "balanced", tickMs: 15_000, ...overrides };
}

function initialCurrent(
  overrides: {
    pressure?: ResourceCircuitState["pressure"];
    admission?: ResourceCircuitState["admission"];
    incidentId?: string | null;
    changedAt?: number;
    lastSampleAt?: number;
    mode?: ResourceGuardianView["mode"];
    reason?: string;
    latestSample?: ResourceSample | null;
  } = {},
): ResourceGuardianCurrentRead {
  const pressure = overrides.pressure ?? "healthy";
  const admission = overrides.admission ?? "open";
  const incidentId = overrides.incidentId ?? null;
  const changedAt = overrides.changedAt ?? 0;
  const lastSampleAt = overrides.lastSampleAt ?? 0;
  const reason = overrides.reason ?? "steady";
  return {
    circuit: {
      schemaVersion: 1,
      pressure,
      incidentId,
      admission,
      reason,
      changedAt,
      lastSampleAt,
      owner: "resource-guardian",
    },
    view: {
      enabled: true,
      mode: overrides.mode ?? "observe",
      profile: "balanced",
      pressure,
      circuit: admission,
      incidentId,
      reason,
      attribution: "unknown",
      latestSample: overrides.latestSample ?? null,
      sampling: {
        degraded: false,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastError: null,
        notifiedPhase: null,
        overlapSkippedTicks: 0,
      },
    },
    degraded: false,
  };
}

class MemoryStore implements ResourceGuardianStore {
  readonly paths = { state: "/state.json", incidents: "/incidents", operator: "/operator.json" };
  current: ResourceGuardianCurrentRead;
  operator: ResourceGuardianOperatorState | null = null;
  incidents = new Map<string, ResourceIncident>();
  writes = 0;
  incidentWrites = 0;
  operatorReads = 0;
  failIncidentWrites = false;
  operations: string[] = [];

  constructor(current = initialCurrent()) {
    this.current = current;
  }

  readCurrent(): ResourceGuardianCurrentRead {
    return structuredClone(this.current);
  }

  readCurrentReadOnly(): ResourceGuardianCurrentRead {
    return this.readCurrent();
  }

  writeCurrent(current: ResourceGuardianCurrentState): void {
    this.operations.push("current");
    if (current.view.mode === "observe" && current.circuit.admission !== "open") {
      throw new Error("invalid observe-mode closed circuit");
    }
    this.writes += 1;
    this.current = { ...structuredClone(current), degraded: false };
  }

  readOperator(): ResourceGuardianOperatorState | null {
    this.operatorReads += 1;
    return this.operator ? structuredClone(this.operator) : null;
  }

  writeOperator(operator: ResourceGuardianOperatorState): void {
    this.operator = structuredClone(operator);
  }

  writeIncident(incident: ResourceIncident): void {
    this.operations.push("incident");
    if (this.failIncidentWrites) throw new Error("incident disk unavailable");
    this.incidentWrites += 1;
    this.incidents.set(incident.id, structuredClone(incident));
  }

  listIncidents(): ResourceIncident[] {
    return [...this.incidents.values()].map((incident) => structuredClone(incident));
  }

  pruneIncidents(): void {}
}

const sent = { status: "sent" as const, deliveries: [] };

describe("resource guardian coordinator", () => {
  it("closes the authoritative circuit before best-effort incident evidence", async () => {
    const store = new MemoryStore();
    let now = 0;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, 94),
      notify: async () => {
        store.operations.push("notify");
        return sent;
      },
      incidentId: () => "incident-order-close",
    });

    for (; now < minute; now += 15_000) await coordinator.run(now);
    store.operations = [];
    store.failIncidentWrites = true;

    await expect(coordinator.run(minute)).resolves.toMatchObject({
      pressure: "elevated",
      circuit: "heavy-closed",
    });
    expect(store.operations.slice(0, 3)).toEqual(["current", "incident", "notify"]);
    expect(store.current.circuit).toMatchObject({
      pressure: "elevated",
      admission: "heavy-closed",
    });
  });

  it("deepens closure before best-effort incident evidence", async () => {
    const store = new MemoryStore();
    let now = 0;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, 94),
      notify: async () => sent,
      incidentId: () => "incident-order-critical",
    });

    for (; now < 90_000; now += 15_000) await coordinator.run(now);
    store.operations = [];
    store.failIncidentWrites = true;

    await expect(coordinator.run(90_000)).resolves.toMatchObject({
      pressure: "critical",
      circuit: "background-closed",
    });
    expect(store.operations.slice(0, 2)).toEqual(["current", "incident"]);
    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
    });
  });

  it("requires incident closure evidence before opening and leaves runtime guarded on failure", async () => {
    const activeIncident: ResourceIncident = {
      schemaVersion: 1,
      id: "incident-order-open",
      fingerprint: "resource-pressure:incident-order-open",
      attribution: "unknown",
      startedAt: 0,
      pressure: "critical",
      samples: [sample(0, 95)],
      transitions: [],
      actions: [],
    };
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: activeIncident.id,
        mode: "protect",
        lastSampleAt: 0,
        latestSample: sample(0, 95),
      }),
    );
    store.incidents.set(activeIncident.id, activeIncident);
    store.failIncidentWrites = true;
    const runtime: ResourceGuardianTickRuntime = {
      initialized: true,
      memory: {
        pressure: "critical",
        stateSince: 0,
        elevatedSince: null,
        criticalSince: null,
        emergencySince: null,
        thermalSince: null,
        recoverySince: 0,
      },
      incident: activeIncident,
    };
    let cpu = 40;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      runtime,
      sample: async (now) => sample(now, cpu),
      notify: async () => sent,
    });

    await expect(coordinator.run(10 * minute)).rejects.toThrow("incident disk unavailable");
    expect(store.operations.at(-1)).toBe("incident");
    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
    });
    expect(coordinator.runtime.memory?.pressure).toBe("critical");

    store.failIncidentWrites = false;
    cpu = 95;
    await coordinator.run(10 * minute + 15_000);
    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
    });
  });

  it.each([
    [false, 15_000],
    [true, 0],
  ])("does no IO when enabled=%s and tickMs=%s", async (enabled, tickMs) => {
    const store = new MemoryStore();
    const takeSample = vi.fn(async () => sample(0, 10));
    const notify = vi.fn(async (_request: unknown) => sent);

    const result = await runResourceGuardianTick({
      now: 0,
      config: config({ enabled, tickMs }),
      runtime: {} as ResourceGuardianTickRuntime,
      store,
      sample: takeSample,
      notify,
      incidentId: () => "incident-disabled",
    });

    expect(result).toEqual({ fired: false, reason: "disabled" });
    expect(takeSample).not.toHaveBeenCalled();
    expect(store.writes).toBe(0);
    expect(store.incidentWrites).toBe(0);
    expect(store.operatorReads).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("honors sustained pressure in observe mode while keeping the circuit open", async () => {
    const store = new MemoryStore();
    let now = 0;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "observe" }),
      store,
      sample: async () => sample(now, 94),
      notify: async () => sent,
      incidentId: () => "incident-observe",
    });

    await coordinator.run(now);
    expect(store.current.circuit.pressure).toBe("healthy");
    for (now = 15_000; now <= 105_000; now += 15_000) await coordinator.run(now);

    expect(store.current.view).toMatchObject({
      mode: "observe",
      pressure: "critical",
      circuit: "open",
      incidentId: "incident-observe",
    });
    expect(store.current.circuit.admission).toBe("open");
  });

  it("maps protect pressure to heavy/background closure and reopens only after recovery", async () => {
    const store = new MemoryStore();
    let now = 0;
    let cpu = 98;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, cpu),
      notify: async () => sent,
      incidentId: () => "incident-protect",
    });

    await coordinator.run(now);
    for (now = 15_000; now <= 75_000; now += 15_000) await coordinator.run(now);
    expect(store.current.circuit).toMatchObject({
      pressure: "elevated",
      admission: "heavy-closed",
    });
    for (; now <= 105_000; now += 15_000) await coordinator.run(now);
    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
    });
    for (; now <= 180_000; now += 15_000) await coordinator.run(now);
    expect(store.current.circuit).toMatchObject({
      pressure: "emergency",
      admission: "background-closed",
    });

    cpu = 40;
    const recoveryStartedAt = now;
    for (; now < recoveryStartedAt + 5 * minute; now += 15_000) await coordinator.run(now);
    await coordinator.run(recoveryStartedAt + 5 * minute);
    expect(store.current.circuit).toMatchObject({
      pressure: "recovering",
      admission: "background-closed",
    });
    for (
      now = recoveryStartedAt + 5 * minute + 15_000;
      now < recoveryStartedAt + 10 * minute;
      now += 15_000
    ) {
      await coordinator.run(now);
    }
    await coordinator.run(recoveryStartedAt + 10 * minute);
    expect(store.current.circuit).toMatchObject({ pressure: "healthy", admission: "open" });
  });

  it("reads live operator mode/profile every tick and falls back to loaded config", async () => {
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: "incident-live",
        lastSampleAt: 0,
        latestSample: sample(0, 95),
        mode: "protect",
      }),
    );
    store.incidents.set("incident-live", {
      schemaVersion: 1,
      id: "incident-live",
      fingerprint: "resource-pressure:incident-live",
      attribution: "unknown",
      startedAt: 0,
      pressure: "critical",
      samples: [sample(0, 95)],
      transitions: [],
      actions: [],
    });
    store.operator = { schemaVersion: 1, mode: "protect", profile: "conservative", updatedAt: 1 };
    let now = 1;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "observe", profile: "balanced" }),
      store,
      sample: async () => sample(now, 40),
      notify: async () => sent,
      incidentId: () => "unused",
    });

    await coordinator.run(now);
    expect(store.current.view).toMatchObject({
      mode: "protect",
      profile: "conservative",
      circuit: "background-closed",
    });
    store.operator = null;
    now = 2;
    await coordinator.run(now);
    expect(store.current.view).toMatchObject({
      mode: "observe",
      profile: "balanced",
      circuit: "open",
    });
    expect(store.operatorReads).toBe(2);
  });

  it("reuses one incident per nonhealthy episode and records samples and transitions", async () => {
    const ids = ["incident-1", "incident-2"];
    const store = new MemoryStore();
    let now = 0;
    let cpu = 85;
    const coordinator = createResourceGuardianCoordinator({
      config: config(),
      store,
      sample: async () => sample(now, cpu),
      notify: async () => sent,
      incidentId: () => ids.shift() ?? "unexpected",
    });

    await coordinator.run(now);
    for (now = 15_000; now <= 75_000; now += 15_000) await coordinator.run(now);
    const firstId = store.current.circuit.incidentId;
    await coordinator.run(now);
    expect(store.current.circuit.incidentId).toBe(firstId);
    expect(store.incidents.get(firstId ?? "")?.samples.length).toBeGreaterThan(1);
    expect(store.incidents.get(firstId ?? "")?.transitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "healthy", to: "elevated" })]),
    );

    cpu = 20;
    now += 15_000;
    await coordinator.run(now);
    expect(store.current.circuit.incidentId).toBeNull();
    expect(store.incidents.get(firstId ?? "")?.endedAt).toBe(now);

    cpu = 85;
    for (now += 15_000; now <= 180_000; now += 15_000) await coordinator.run(now);
    expect(store.current.circuit.incidentId).toBe("incident-2");
    expect(store.current.circuit.incidentId).not.toBe(firstId);
  });

  it("notifies only on pressure transitions with the shared event semantics", async () => {
    const store = new MemoryStore();
    const notify = vi.fn(async () => sent);
    let now = 0;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, 85),
      notify,
      incidentId: () => "incident-notify",
    });

    await coordinator.run(now);
    for (now = 15_000; now <= 75_000; now += 15_000) await coordinator.run(now);
    expect(notify).toHaveBeenCalledTimes(1);
    const expected = notificationRequestForEvent({
      kind: "resource.pressure-transition",
      oldState: "healthy",
      newState: "elevated",
      incidentId: "incident-notify",
      hostCpuPct: 85,
      circuit: "heavy-closed",
      actionSummary: "protect mode closed heavy background admission",
    });
    expect(notify).toHaveBeenLastCalledWith(expected);

    now += 15_000;
    await coordinator.run(now);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.incidents.get("incident-notify")?.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "notification" })]),
    );
  });

  it("preserves recent closed state on sampling failure, then degrades open once after 15 minutes", async () => {
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: "incident-stale",
        lastSampleAt: 1_000,
        changedAt: 500,
        mode: "protect",
        latestSample: sample(1_000, 95),
      }),
    );
    const notify = vi.fn(async (_request: unknown) => sent);
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => {
        throw new Error("probe unavailable");
      },
      notify,
      incidentId: () => "unused",
      staleHoldMs: 15 * minute,
    });

    await expect(coordinator.run(1_000 + 10 * minute)).resolves.toMatchObject({
      reason: "sample-failed",
    });
    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
      changedAt: 500,
      lastSampleAt: 1_000,
    });
    expect(store.current).toMatchObject({
      circuit: { lastSampleAt: 1_000 },
      view: {
        sampling: {
          degraded: true,
          consecutiveFailures: 1,
          lastFailureAt: 1_000 + 10 * minute,
          notifiedPhase: null,
        },
      },
    });
    expect(notify).not.toHaveBeenCalled();

    await expect(coordinator.run(1_000 + 16 * minute)).resolves.toMatchObject({
      reason: "sample-stale",
    });
    expect(store.current).toMatchObject({
      circuit: { pressure: "critical", admission: "open", lastSampleAt: 1_000 },
      view: { mode: "observe", circuit: "open" },
    });
    expect(store.current.circuit.reason).toMatch(/sample.*stale.*observe-only/i);
    const staleReason = store.current.circuit.reason;
    expect(store.current.view).toMatchObject({
      sampling: {
        degraded: true,
        consecutiveFailures: 2,
        notifiedPhase: "stale-hold-expired",
      },
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ title: "Resource sampling degraded" });
    expect(notify.mock.calls[1]?.[0]).toMatchObject({
      title: "Resource sampling stale hold expired",
    });

    await coordinator.run(1_000 + 17 * minute);
    expect(store.current).toMatchObject({
      circuit: { admission: "open", reason: staleReason },
      view: {
        mode: "observe",
        circuit: "open",
        reason: staleReason,
        sampling: { consecutiveFailures: 3, notifiedPhase: "stale-hold-expired" },
      },
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("persists bounded redacted sampling health for healthy/open failures without spam", async () => {
    const store = new MemoryStore();
    const notify = vi.fn(async () => sent);
    const privatePath = `${homedir()}/private/project`;
    const secret = "token=super-secret-value";
    const coordinator = createResourceGuardianCoordinator({
      config: config(),
      store,
      sample: async () => {
        throw new Error(`${privatePath} ${secret} ${"x".repeat(1_000)}`);
      },
      notify,
    });

    await coordinator.run(10);
    await coordinator.run(20);

    expect(store.current.circuit).toMatchObject({ admission: "open", lastSampleAt: 0 });
    expect(store.current.view).toMatchObject({
      sampling: {
        degraded: true,
        consecutiveFailures: 2,
        lastFailureAt: 20,
        notifiedPhase: "sampling-failed",
      },
    });
    const error = (store.current.view as unknown as { sampling: { lastError: string } }).sampling
      .lastError;
    expect(error.length).toBeLessThanOrEqual(500);
    expect(error).not.toContain(homedir());
    expect(error).not.toContain("super-secret-value");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("persists a sampling failure from the store's conservative invalid-state fallback", async () => {
    const fallback = initialCurrent({
      pressure: "critical",
      admission: "background-closed",
      mode: "observe",
      changedAt: 10,
      lastSampleAt: 10,
    });
    fallback.degraded = true;
    const store = new MemoryStore(fallback);
    store.operator = {
      schemaVersion: 1,
      mode: "protect",
      profile: "conservative",
      updatedAt: 15,
    };
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "observe" }),
      store,
      sample: async () => {
        throw new Error("probe unavailable");
      },
      notify: async () => sent,
    });

    await expect(coordinator.run(20)).resolves.toMatchObject({ reason: "sample-failed" });
    expect(store.current).toMatchObject({
      circuit: { pressure: "critical", admission: "background-closed", lastSampleAt: 10 },
      view: {
        enabled: true,
        mode: "protect",
        profile: "conservative",
        sampling: { degraded: true, consecutiveFailures: 1 },
      },
    });
  });

  it.each([
    { label: "live operator", configMode: "protect" as const, operator: true },
    { label: "loaded config", configMode: "observe" as const, operator: false },
  ])("treats $label observe mode as authoritative during sampling failure", async (scenario) => {
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: "incident-observe-failure",
        mode: "protect",
        changedAt: 10,
        lastSampleAt: 10,
      }),
    );
    if (scenario.operator) {
      store.operator = {
        schemaVersion: 1,
        mode: "observe",
        profile: "conservative",
        updatedAt: 15,
      };
    }
    const notify = vi.fn(async (_request: unknown) => sent);
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: scenario.configMode }),
      store,
      sample: async () => {
        throw new Error("probe unavailable");
      },
      notify,
    });

    await expect(coordinator.run(20)).resolves.toMatchObject({
      reason: "sample-failed",
      circuit: "open",
    });
    expect(store.current).toMatchObject({
      circuit: { pressure: "critical", admission: "open", lastSampleAt: 10 },
      view: {
        mode: "observe",
        profile: scenario.operator ? "conservative" : "balanced",
        sampling: {
          degraded: true,
          consecutiveFailures: 1,
          notifiedPhase: null,
        },
      },
    });
    expect(notify).not.toHaveBeenCalled();

    await coordinator.run(30);
    expect(store.current.view.sampling.consecutiveFailures).toBe(2);
    expect(store.current.view.sampling.notifiedPhase).toBe("sampling-failed");
    expect(notify).toHaveBeenCalledTimes(1);
    await coordinator.run(40);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("requires incident evidence before stale fallback protection can open", async () => {
    const fallback = initialCurrent({
      pressure: "critical",
      admission: "background-closed",
      mode: "observe",
      changedAt: 0,
      lastSampleAt: 0,
    });
    fallback.degraded = true;
    const store = new MemoryStore(fallback);
    store.failIncidentWrites = true;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => {
        throw new Error("probe unavailable");
      },
      notify: async () => sent,
      incidentId: () => "incident-fallback-stale",
      staleHoldMs: 15 * minute,
    });

    await expect(coordinator.run(16 * minute)).rejects.toThrow("incident disk unavailable");
    expect(store.operations).toEqual(["incident"]);
    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
      incidentId: null,
    });
  });

  it("resets durable sampling failures after the next fresh sample", async () => {
    const store = new MemoryStore();
    let failing = true;
    const notify = vi.fn(async (_request: unknown) => sent);
    const coordinator = createResourceGuardianCoordinator({
      config: config(),
      store,
      sample: async (now) => {
        if (failing) throw new Error("probe failed");
        return sample(now, 20);
      },
      notify,
    });

    await coordinator.run(10);
    expect(notify).not.toHaveBeenCalled();
    failing = false;
    await coordinator.run(20);

    expect(store.current.view).toMatchObject({
      sampling: {
        degraded: false,
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastError: null,
        notifiedPhase: null,
      },
    });
    failing = true;
    await coordinator.run(30);
    expect(store.current.view.sampling.consecutiveFailures).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it("reconstructs recent closed memory on restart and requires a fresh recovery window", async () => {
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: "incident-restart",
        lastSampleAt: 0,
        changedAt: 0,
        mode: "protect",
        latestSample: sample(0, 95),
      }),
    );
    store.incidents.set("incident-restart", {
      schemaVersion: 1,
      id: "incident-restart",
      fingerprint: "resource-pressure:incident-restart",
      attribution: "unknown",
      startedAt: 0,
      pressure: "critical",
      samples: [sample(0, 95)],
      transitions: [],
      actions: [],
    });
    let now = minute;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, 40),
      notify: async () => sent,
      incidentId: () => "unexpected",
      staleHoldMs: 15 * minute,
    });

    await coordinator.run(now);
    expect(store.current.circuit.pressure).toBe("critical");
    for (now += 15_000; now < 6 * minute; now += 15_000) await coordinator.run(now);
    await coordinator.run(6 * minute);
    expect(store.current.circuit.pressure).toBe("recovering");
    for (now = 6 * minute + 15_000; now < 11 * minute; now += 15_000) await coordinator.run(now);
    await coordinator.run(11 * minute);
    expect(store.current.circuit).toMatchObject({ pressure: "healthy", admission: "open" });
  });

  it("conservatively restores stale closed pressure when a fresh high sample succeeds", async () => {
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: "incident-stale-restart-high",
        lastSampleAt: 0,
        changedAt: 0,
        mode: "protect",
        latestSample: sample(0, 95),
      }),
    );
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async (now) => sample(now, 95),
      notify: async () => sent,
      staleHoldMs: 15 * minute,
    });

    await coordinator.run(20 * minute);

    expect(store.current.circuit).toMatchObject({
      pressure: "critical",
      admission: "background-closed",
    });
  });

  it("starts a complete recovery window from a stale closed circuit's first fresh low sample", async () => {
    const store = new MemoryStore(
      initialCurrent({
        pressure: "critical",
        admission: "background-closed",
        incidentId: "incident-stale-restart-low",
        lastSampleAt: 0,
        changedAt: 0,
        mode: "protect",
        latestSample: sample(0, 95),
      }),
    );
    let now = 20 * minute;
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, 40),
      notify: async () => sent,
      staleHoldMs: 15 * minute,
    });

    await coordinator.run(now);
    expect(store.current.circuit.pressure).toBe("critical");
    for (now += 15_000; now < 25 * minute; now += 15_000) await coordinator.run(now);
    await coordinator.run(25 * minute);
    expect(store.current.circuit.pressure).toBe("recovering");
    for (now = 25 * minute + 15_000; now < 30 * minute; now += 15_000) {
      await coordinator.run(now);
    }
    await coordinator.run(30 * minute);
    expect(store.current.circuit).toMatchObject({ pressure: "healthy", admission: "open" });
  });

  it("serializes ticks and start/stop uses one idempotent timer", async () => {
    const store = new MemoryStore();
    let release: (() => void) | undefined;
    const takeSample = vi.fn(
      () => new Promise<ResourceSample>((resolve) => (release = () => resolve(sample(0, 10)))),
    );
    const notify = vi.fn(async () => sent);
    let intervalTick: (() => void) | undefined;
    const timer = { id: 1 } as unknown as NodeJS.Timeout;
    const setIntervalFn = vi.fn((tick: () => void) => {
      intervalTick = tick;
      return timer;
    });
    const clearIntervalFn = vi.fn();
    const deps = {
      config: { resourceGuardian: config() },
      notifications: { notify },
    } as unknown as Parameters<typeof startResourceGuardian>[0];

    const stop = startResourceGuardian(deps, {
      store,
      sample: takeSample,
      now: () => 0,
      incidentId: () => "unused",
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });
    await Promise.resolve();
    expect(takeSample).toHaveBeenCalledTimes(1);
    intervalTick?.();
    await Promise.resolve();
    expect(takeSample).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => expect(store.writes).toBe(1));
    expect(store.current).toMatchObject({
      view: { sampling: { overlapSkippedTicks: 1 } },
    });
    stop();
    stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it("passes actual and expected schedule times to sampling", async () => {
    const store = new MemoryStore();
    const takeSample = vi.fn(async (actualNow: number, scheduledAt: number) =>
      sample(actualNow, scheduledAt),
    );
    const times = [1_000, 1_200, 2_500];
    let intervalTick: (() => void) | undefined;
    const stop = startResourceGuardian(
      {
        config: { resourceGuardian: config({ tickMs: 1_000 }) },
        notifications: { notify: async () => sent },
      } as unknown as Parameters<typeof startResourceGuardian>[0],
      {
        store,
        sample: takeSample,
        now: () => times.shift() ?? 2_500,
        setInterval: ((tick: () => void) => {
          intervalTick = tick;
          return { id: 2 } as unknown as NodeJS.Timeout;
        }) as NonNullable<StartResourceGuardianTestOptions["setInterval"]>,
        clearInterval: () => {},
      },
    );

    await vi.waitFor(() => expect(takeSample).toHaveBeenCalledTimes(1));
    expect(takeSample).toHaveBeenNthCalledWith(1, 1_200, 1_000);
    intervalTick?.();
    await vi.waitFor(() => expect(takeSample).toHaveBeenCalledTimes(2));
    expect(takeSample).toHaveBeenNthCalledWith(2, 2_500, 2_000);
    stop();
  });

  it("drops queued and in-flight ticks after stop", async () => {
    const store = new MemoryStore();
    const notify = vi.fn(async () => sent);
    let release: (() => void) | undefined;
    const takeSample = vi.fn(
      () => new Promise<ResourceSample>((resolve) => (release = () => resolve(sample(10, 85)))),
    );
    let intervalTick: (() => void) | undefined;
    const stop = startResourceGuardian(
      {
        config: { resourceGuardian: config() },
        notifications: { notify },
      } as unknown as Parameters<typeof startResourceGuardian>[0],
      {
        store,
        sample: takeSample,
        now: () => 10,
        setInterval: ((tick: () => void) => {
          intervalTick = tick;
          return { id: 3 } as unknown as NodeJS.Timeout;
        }) as NonNullable<StartResourceGuardianTestOptions["setInterval"]>,
        clearInterval: () => {},
      },
    );
    await vi.waitFor(() => expect(takeSample).toHaveBeenCalledTimes(1));

    stop();
    intervalTick?.();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(takeSample).toHaveBeenCalledTimes(1);
    expect(store.writes).toBe(0);
    expect(store.incidentWrites).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("contains sampling and notification failures without reopening a closed circuit", async () => {
    const store = new MemoryStore();
    let now = 0;
    const notify = vi.fn(async () => {
      throw new Error("sender down");
    });
    const coordinator = createResourceGuardianCoordinator({
      config: config({ mode: "protect" }),
      store,
      sample: async () => sample(now, 85),
      notify,
      incidentId: () => "incident-notify-fail",
    });

    await coordinator.run(now);
    for (now = 15_000; now <= 75_000; now += 15_000) {
      await expect(coordinator.run(now)).resolves.toBeDefined();
    }
    expect(store.current.circuit).toMatchObject({
      pressure: "elevated",
      admission: "heavy-closed",
    });
    expect(store.incidents.get("incident-notify-fail")?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "notification",
          outcome: "failed",
          reason: expect.stringMatching(/sender down/),
        }),
      ]),
    );
  });
});
