import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pauseRun, resumeRun, startPlan, stopRun } from "../../src/core/scheduler/controls.js";
import { SchedulerStore } from "../../src/core/scheduler/scheduler-store.js";
import type { Plan } from "../../src/core/scheduler/types.js";

const plan: Plan = {
  id: "test-plan",
  name: "Test Plan",
  pools: { claude: 2 },
  projects: [
    { path: "/project/a", agent: "claude", goals: ["fix-tests"] },
    { path: "/project/b", agent: "claude", goals: ["fix-tests"] },
  ],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-controls-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("controls", () => {
  it("startPlan returns error when plan does not exist", () => {
    const store = new SchedulerStore();
    const result = startPlan(store, "no-such-plan", Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unknown plan/i);
    }
  });

  it("startPlan materialises an active run with queued tasks", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    const now = Date.now();
    const result = startPlan(store, "test-plan", now);
    expect(result.ok).toBe(true);
    const run = store.getActiveRun();
    expect(run).toBeDefined();
    expect(run?.planId).toBe("test-plan");
    expect(run?.status).toBe("running");
    expect(run?.tasks).toHaveLength(2);
    expect(run?.tasks.every((t) => t.status === "queued")).toBe(true);
  });

  it("startPlan returns error when a run is already active", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    startPlan(store, "test-plan", Date.now());
    const second = startPlan(store, "test-plan", Date.now());
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatch(/already active/i);
    }
  });

  it("pauseRun flips status to paused", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    startPlan(store, "test-plan", Date.now());
    const result = pauseRun(store);
    expect(result.ok).toBe(true);
    expect(store.getActiveRun()?.status).toBe("paused");
  });

  it("resumeRun flips status back to running", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    startPlan(store, "test-plan", Date.now());
    pauseRun(store);
    const result = resumeRun(store);
    expect(result.ok).toBe(true);
    expect(store.getActiveRun()?.status).toBe("running");
  });

  it("stopRun clears the active run", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    startPlan(store, "test-plan", Date.now());
    stopRun(store);
    expect(store.getActiveRun()).toBeUndefined();
  });

  it("pauseRun returns error when no active run", () => {
    const store = new SchedulerStore();
    const result = pauseRun(store);
    expect(result.ok).toBe(false);
  });

  it("resumeRun returns error when no active run", () => {
    const store = new SchedulerStore();
    const result = resumeRun(store);
    expect(result.ok).toBe(false);
  });

  it("stopRun is a no-op when no active run", () => {
    const store = new SchedulerStore();
    // Should not throw
    stopRun(store);
    expect(store.getActiveRun()).toBeUndefined();
  });
});
