import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentCapacityStore } from "../../../src/core/automation/capacity-store.js";

const originalStateDir = process.env.TCB_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tcb-capacity-store-"));
  process.env.TCB_STATE_DIR = stateDir;
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("AgentCapacityStore", () => {
  it("persists observations, leases, and autonomous start time", () => {
    const store = new AgentCapacityStore();
    store.recordObservation({
      agent: "codex",
      authentication: "subscription",
      state: "unknown",
      fiveHourPct: null,
      weeklyPct: null,
      resetAt: null,
      observedAt: 1_000,
      nextProbeAt: 901_000,
      latestReason: "usage-telemetry-unavailable",
    });
    expect(store.acquireLease("codex", "lease-1", 2_000)).toBe(true);
    store.recordAutonomousStart("codex", 3_000);

    expect(new AgentCapacityStore().read("codex", 3_000)).toMatchObject({
      state: "unknown",
      activeAutonomousLeases: 1,
      lastAutonomousStartAt: 3_000,
    });
    expect(store.releaseLease("codex", "lease-1")).toBe(true);
    expect(store.read("codex").activeAutonomousLeases).toBe(0);
  });

  it("renews the same durable lease identity after its previous TTL expires", () => {
    const store = new AgentCapacityStore();
    store.ensureUnknown("codex", 100);
    expect(store.acquireLease("codex", "lease-restart", 100, 100)).toBe(true);
    expect(store.read("codex", 201).activeAutonomousLeases).toBe(0);

    expect(store.acquireLease("codex", "lease-restart", 201, 100)).toBe(true);
    expect(store.hasLease("codex", "lease-restart", 201)).toBe(true);
    expect(store.read("codex", 201).activeAutonomousLeases).toBe(1);
  });

  it("fails unknown when a persisted record is invalid", () => {
    mkdirSync(join(stateDir, "automation-admission"), { recursive: true });
    writeFileSync(
      join(stateDir, "automation-admission", "current.json"),
      '{"codex":{"state":"available"}}',
    );

    expect(new AgentCapacityStore().read("codex")).toMatchObject({
      state: "unknown",
      latestReason: "capacity-state-invalid",
    });
  });

  it("rejects malformed numeric telemetry instead of trusting partial durable state", () => {
    mkdirSync(join(stateDir, "automation-admission"), { recursive: true });
    writeFileSync(
      join(stateDir, "automation-admission", "current.json"),
      JSON.stringify({
        codex: {
          schemaVersion: 1,
          observation: {
            agent: "codex",
            authentication: "subscription",
            state: "available",
            fiveHourPct: "not-a-number",
            weeklyPct: null,
            resetAt: null,
            observedAt: 1_000,
            nextProbeAt: 2_000,
            latestReason: "usage-available",
          },
          leases: {},
          lastAutonomousStartAt: null,
        },
      }),
    );

    expect(new AgentCapacityStore().read("codex")).toMatchObject({
      state: "unknown",
      latestReason: "capacity-state-invalid",
    });
  });

  it("reopens expired exhaustion as unknown pending a fresh local probe", () => {
    const store = new AgentCapacityStore();
    store.recordObservation({
      agent: "claude",
      authentication: "subscription",
      state: "exhausted",
      fiveHourPct: 100,
      weeklyPct: 20,
      resetAt: 2_000,
      observedAt: 1_000,
      nextProbeAt: 2_000,
      latestReason: "usage-exhausted",
    });

    expect(store.read("claude", 2_001)).toMatchObject({
      state: "unknown",
      resetAt: null,
      nextProbeAt: 2_001,
      latestReason: "capacity-reset-passed",
    });
  });
});
