import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBatchCommand } from "../../src/core/scheduler/batch-command.js";
import { SchedulerStore } from "../../src/core/scheduler/scheduler-store.js";
import type { Plan } from "../../src/core/scheduler/types.js";

const plan: Plan = {
  id: "my-plan",
  name: "My Plan",
  pools: { claude: 1 },
  projects: [{ path: "/project/a", agent: "claude", goals: ["task-1"] }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-batch-cmd-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("runBatchCommand", () => {
  it("empty arg returns status (no active run)", () => {
    const result = runBatchCommand("");
    expect(result).toBe("No active batch run.");
  });

  it("start with missing planId returns usage", () => {
    const result = runBatchCommand("start");
    expect(result).toMatch(/usage/i);
  });

  it("start with unknown planId returns error", () => {
    const result = runBatchCommand("start no-such-plan");
    expect(result).toMatch(/error/i);
    expect(result).toMatch(/unknown plan/i);
  });

  it("start with a valid planId activates the run", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);

    const result = runBatchCommand("start my-plan");
    expect(result).toMatch(/started/i);
    expect(store.getActiveRun()).toBeDefined();
    expect(store.getActiveRun()?.status).toBe("running");
  });

  it("empty arg returns status of active run after start", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    runBatchCommand("start my-plan");

    const result = runBatchCommand("");
    // renderStatus shows the runId and status
    expect(result).toMatch(/running/i);
    expect(result).toMatch(/^Batch run-\d+/);
  });

  it("pause returns ok after start", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    runBatchCommand("start my-plan");

    const result = runBatchCommand("pause");
    expect(result).toMatch(/paused/i);
    expect(store.getActiveRun()?.status).toBe("paused");
  });

  it("resume returns ok after pause", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    runBatchCommand("start my-plan");
    runBatchCommand("pause");

    const result = runBatchCommand("resume");
    expect(result).toMatch(/resumed/i);
    expect(store.getActiveRun()?.status).toBe("running");
  });

  it("stop clears the active run", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    runBatchCommand("start my-plan");

    const result = runBatchCommand("stop");
    expect(result).toMatch(/stopped/i);
    expect(store.getActiveRun()).toBeUndefined();
  });

  it("pause with no active run returns error", () => {
    const result = runBatchCommand("pause");
    expect(result).toMatch(/error/i);
  });

  it("resume with no active run returns error", () => {
    const result = runBatchCommand("resume");
    expect(result).toMatch(/error/i);
  });

  it("report with no active run returns 'No active batch run.'", () => {
    const result = runBatchCommand("report");
    expect(result).toBe("No active batch run.");
  });

  it("report with active run returns summary text", () => {
    const store = new SchedulerStore();
    store.savePlan(plan);
    runBatchCommand("start my-plan");

    const result = runBatchCommand("report");
    // renderSummary shows the runId (run-{ts}) and status
    expect(result).toMatch(/^Batch run-\d+/);
    expect(result).toMatch(/running/i);
  });

  it("unknown verb returns usage guidance", () => {
    const result = runBatchCommand("frobnitz");
    expect(result).toMatch(/unknown verb/i);
    expect(result).toMatch(/frobnitz/);
  });
});
