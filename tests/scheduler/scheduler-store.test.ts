import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchedulerStore } from "../../src/core/scheduler/scheduler-store.js";
import type { Plan, PoolState, Run } from "../../src/core/scheduler/types.js";

const plan: Plan = {
  id: "p1",
  name: "nightly",
  pools: { claude: 3 },
  projects: [{ path: "/a", agent: "claude", goals: ["fix-tests"] }],
};
const run: Run = { runId: "r1", planId: "p1", startedAt: 1000, status: "running", tasks: [] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-sched-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("SchedulerStore", () => {
  it("persists and reloads plans across instances", () => {
    new SchedulerStore().savePlan(plan);
    const fresh = new SchedulerStore();
    expect(fresh.getPlan("p1")).toEqual(plan);
    expect(fresh.listPlans()).toHaveLength(1);
  });

  it("persists, reloads, and clears the active run", () => {
    const s = new SchedulerStore();
    s.setActiveRun(run);
    expect(new SchedulerStore().getActiveRun()).toEqual(run);
    s.setActiveRun(null);
    expect(new SchedulerStore().getActiveRun()).toBeUndefined();
  });

  // Bug #1 — pools persistence round-trip: getPools returns {} on a fresh store,
  // setPools writes, and a new instance reads back the exact same entries.
  it("getPools returns empty map on a fresh store", () => {
    expect(new SchedulerStore().getPools()).toEqual({});
  });

  it("setPools/getPools round-trips pool state across instances", () => {
    const pools: Record<string, PoolState> = {
      claude: { paused: true, resumeAt: 9_000_000 },
    };
    new SchedulerStore().setPools(pools);
    expect(new SchedulerStore().getPools()).toEqual(pools);
  });

  it("setPools overwrites stale entries (clears then writes)", () => {
    const s = new SchedulerStore();
    s.setPools({ claude: { paused: true, resumeAt: 9_000_000 } });
    // Overwrite with only a different agent — claude must not linger.
    s.setPools({ codex: { paused: false } });
    const loaded = new SchedulerStore().getPools();
    expect(loaded).toEqual({ codex: { paused: false } });
    expect(loaded["claude"]).toBeUndefined();
  });

  // Bug #7 — stale lastFired blocks a re-added `now`-plan with the same id.
  // savePlan must clear the plan's fire anchor so the freshly-loaded plan fires
  // on the next tick rather than being permanently skipped by the stale timestamp.
  it("savePlan clears lastFired for the plan's id", () => {
    const s = new SchedulerStore();

    // Simulate a previous run having recorded a fire time for plan "p".
    s.setLastFired({ p: 12345 });
    expect(new SchedulerStore().getLastFired()["p"]).toBe(12345);

    // Loading the plan with the same id must reset the anchor.
    s.savePlan({ id: "p", name: "n", pools: { claude: 1 }, projects: [] });
    expect(new SchedulerStore().getLastFired()["p"]).toBeUndefined();
  });

  it("savePlan does not clear lastFired for unrelated plan ids", () => {
    const s = new SchedulerStore();
    s.setLastFired({ p: 111, other: 222 });
    s.savePlan({ id: "p", name: "n", pools: { claude: 1 }, projects: [] });
    // Only "p" cleared; "other" must be preserved.
    expect(new SchedulerStore().getLastFired()["other"]).toBe(222);
  });
});
