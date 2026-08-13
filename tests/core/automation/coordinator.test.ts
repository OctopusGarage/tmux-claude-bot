import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCapacityStore } from "../../../src/core/automation/capacity-store.js";
import { AutonomousWorkCoordinator } from "../../../src/core/automation/coordinator.js";
import { AutomationOccurrenceStore } from "../../../src/core/automation/occurrence-window.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;
const now = Date.UTC(2026, 7, 13, 10, 0, 0);

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-automation-coordinator-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

function available(store: AgentCapacityStore): void {
  store.recordObservation({
    agent: "claude",
    authentication: "subscription",
    state: "available",
    fiveHourPct: 20,
    weeklyPct: 10,
    resetAt: null,
    observedAt: now,
    nextProbeAt: now + 60_000,
    latestReason: "usage-available",
  });
}

describe("AutonomousWorkCoordinator", () => {
  it("revalidates immediately before execution and settles its durable lease", async () => {
    const capacity = new AgentCapacityStore();
    const occurrences = new AutomationOccurrenceStore({ randomOffset: () => 0 });
    available(capacity);
    const occurrence = occurrences.plan({
      key: "loop:architecture",
      scheduledAt: now,
      windowMs: 0,
      now,
    });
    let clock = now;
    const coordinator = new AutonomousWorkCoordinator({
      capacity,
      occurrences,
      now: () => clock,
    });
    const intent = {
      id: "run-1",
      source: "loop-engineering" as const,
      trigger: "background" as const,
      weight: "heavy" as const,
      agent: "claude" as const,
      occurrenceId: occurrence.id,
    };

    expect(coordinator.precheck(intent, {}).allowed).toBe(true);
    clock += 1_000;
    const result = await coordinator.execute(intent, {}, async () => "done");

    expect(result).toEqual({ executed: true, value: "done" });
    expect(capacity.read("claude", clock).activeAutonomousLeases).toBe(0);
    expect(capacity.read("claude", clock).lastAutonomousStartAt).toBe(clock);
    expect(occurrences.get(occurrence.id)?.status).toBe("settled");
  });

  it("can hold the final admission across asynchronous dispatch and settle it later", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });
    const intent = {
      id: "run-held",
      source: "autopilot-delegate" as const,
      trigger: "background" as const,
      weight: "heavy" as const,
      agent: "claude" as const,
    };

    expect(coordinator.precheck(intent, {}).allowed).toBe(true);
    const admitted = coordinator.admit(intent, {});
    expect(admitted.allowed).toBe(true);
    expect(capacity.read("claude", now).activeAutonomousLeases).toBe(1);

    if (!admitted.allowed) throw new Error("expected final admission");
    coordinator.settle(admitted.lease);
    expect(capacity.read("claude", now).activeAutonomousLeases).toBe(0);
  });

  it("rechecks changed capacity at final admission without acquiring a lease", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });
    const intent = {
      id: "run-deferred",
      source: "loop-engineering" as const,
      trigger: "background" as const,
      weight: "heavy" as const,
      agent: "claude" as const,
    };

    expect(coordinator.precheck(intent, {}).allowed).toBe(true);
    capacity.recordObservation({
      agent: "claude",
      authentication: "subscription",
      state: "exhausted",
      fiveHourPct: 100,
      weeklyPct: 20,
      resetAt: now + 60_000,
      observedAt: now,
      nextProbeAt: now + 60_000,
      latestReason: "usage-exhausted",
    });

    expect(coordinator.admit(intent, {})).toMatchObject({
      allowed: false,
      reason: "capacity-exhausted",
    });
    expect(capacity.read("claude", now).activeAutonomousLeases).toBe(0);
  });

  it("revalidates a held provisional lease without counting that lease against itself", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });
    const intent = {
      id: "run-prepared",
      source: "loop-engineering" as const,
      trigger: "background" as const,
      weight: "heavy" as const,
      agent: "claude" as const,
    };
    const admitted = coordinator.admit(intent, {});
    if (!admitted.allowed) throw new Error("expected provisional admission");

    expect(coordinator.revalidate(admitted.lease, {}).allowed).toBe(true);
    capacity.recordObservation({
      agent: "claude",
      authentication: "subscription",
      state: "exhausted",
      fiveHourPct: 100,
      weeklyPct: 20,
      resetAt: now + 60_000,
      observedAt: now,
      nextProbeAt: now + 60_000,
      latestReason: "usage-exhausted",
    });
    expect(coordinator.revalidate(admitted.lease, {})).toMatchObject({
      allowed: false,
      reason: "capacity-exhausted",
    });
    coordinator.settle(admitted.lease, { settleOccurrence: false });
  });

  it("allows only one autonomous start when telemetry is unknown", async () => {
    const capacity = new AgentCapacityStore();
    capacity.ensureUnknown("claude", now);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });
    let releaseFirst: (() => void) | undefined;
    const first = coordinator.execute(
      {
        id: "run-1",
        source: "loop-engineering",
        trigger: "background",
        weight: "heavy",
        agent: "claude",
      },
      {},
      () => new Promise<string>((resolve) => (releaseFirst = () => resolve("done"))),
    );
    await Promise.resolve();

    const second = await coordinator.execute(
      {
        id: "run-2",
        source: "loop-engineering",
        trigger: "background",
        weight: "heavy",
        agent: "claude",
      },
      {},
      async () => "unexpected",
    );
    expect(second).toMatchObject({
      executed: false,
      admission: { allowed: false, reason: "capacity-unknown-active-lease" },
    });
    releaseFirst?.();
    await first;
  });

  it("lets the same durable intent reclaim its lease after process restart", () => {
    const capacity = new AgentCapacityStore();
    capacity.ensureUnknown("claude", now);
    const intent = {
      id: "run-restart",
      source: "autopilot-delegate" as const,
      trigger: "reconcile" as const,
      weight: "heavy" as const,
      agent: "claude" as const,
    };
    const first = new AutonomousWorkCoordinator({ capacity, now: () => now }).admit(intent, {});
    if (!first.allowed) throw new Error("expected initial admission");

    const restored = new AutonomousWorkCoordinator({ capacity, now: () => now }).admit(intent, {});
    expect(restored.allowed).toBe(true);
    expect(capacity.read("claude", now).activeAutonomousLeases).toBe(1);
    if (restored.allowed) {
      new AutonomousWorkCoordinator({ capacity, now: () => now }).settle(restored.lease);
    }
  });

  it("records a locally observed official limit signal without retaining raw output", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });

    expect(coordinator.recordLimitSignal("claude", "Usage limit reached; try again later")).toBe(
      true,
    );
    expect(capacity.read("claude", now)).toMatchObject({
      state: "exhausted",
      latestReason: "official-limit-signal",
      resetAt: null,
    });
  });

  it("recognizes the official hit-your-limit phrasing but ignores ordinary failures", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });

    expect(
      coordinator.recordLimitSignal("claude", "You've hit your usage limit · resets 18:00"),
    ).toBe(true);
    expect(coordinator.recordLimitSignal("codex", "system gate failed: tests failed")).toBe(false);
  });

  it("persists an explicit official reset and ignores quoted limit discussion", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const coordinator = new AutonomousWorkCoordinator({ capacity, now: () => now });

    expect(
      coordinator.recordLimitSignal(
        "claude",
        "You've hit your usage limit · resets 2026-08-13T20:00:00+08:00",
      ),
    ).toBe(true);
    expect(capacity.read("claude", now)).toMatchObject({
      state: "exhausted",
      resetAt: Date.parse("2026-08-13T20:00:00+08:00"),
      nextProbeAt: Date.parse("2026-08-13T20:00:00+08:00"),
    });

    available(capacity);
    expect(
      coordinator.recordLimitSignal(
        "claude",
        'review note: the phrase "rate limit reached" appears in a test fixture',
      ),
    ).toBe(false);
    expect(capacity.read("claude", now).state).toBe("available");
  });

  it("emits only meaningful capacity transitions", () => {
    const capacity = new AgentCapacityStore();
    available(capacity);
    const transitions: Array<{ from: string; to: string }> = [];
    const coordinator = new AutonomousWorkCoordinator({
      capacity,
      now: () => now,
      onCapacityTransition: (transition) => {
        transitions.push(transition);
      },
    });

    expect(coordinator.recordLimitSignal("claude", "Usage limit reached")).toBe(true);
    expect(coordinator.recordLimitSignal("claude", "Usage limit reached")).toBe(true);
    coordinator.recordCapacityObservation(
      {
        agent: "claude",
        authentication: "subscription",
        state: "available",
        fiveHourPct: 20,
        weeklyPct: 10,
        resetAt: null,
        observedAt: now + 60_000,
        nextProbeAt: now + 120_000,
        latestReason: "usage-available",
      },
      "loop-engineering",
    );

    expect(transitions.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "available", to: "exhausted" },
      { from: "exhausted", to: "available" },
    ]);
  });
});
