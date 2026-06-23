// tests/scheduler/scheduler.test.ts
import { describe, expect, it } from "vitest";
import type { AutopilotState } from "../../src/core/autopilot/types.js";
import { defaultState } from "../../src/core/autopilot/types.js";
import { applyNotice, reconcile } from "../../src/core/scheduler/scheduler.js";
import type { PoolState, Run, TaskState } from "../../src/core/scheduler/types.js";

const task = (over: Partial<TaskState>): TaskState => ({
  project: "/p",
  agent: "claude",
  goals: ["fix-tests"],
  rounds: 1,
  retries: 0,
  priority: 0,
  status: "queued",
  attempt: 0,
  goalsCompleted: [],
  ...over,
});
const run = (tasks: TaskState[]): Run => ({
  runId: "r",
  planId: "p",
  startedAt: 0,
  status: "running",
  tasks,
});
const pools: Record<string, PoolState> = { claude: { paused: false } };

function fakeAutopilot() {
  const map = new Map<string, AutopilotState>();
  return {
    map,
    get: (s: string) => map.get(s) ?? defaultState(),
    set: (s: string, st: AutopilotState) => void map.set(s, st),
  };
}

describe("reconcile", () => {
  it("admits up to cap: seeds autopilot (enabled + goal + viaScheduler) and marks running", () => {
    const ap = fakeAutopilot();
    const r0 = run([task({ project: "/a" }), task({ project: "/b" })]);
    const r1 = reconcile(r0, { claude: 1 }, pools, {
      autopilot: ap,
      resolveSession: (t) => t.project,
      now: 1000,
    });
    const running = r1.tasks.filter((t) => t.status === "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.project).toBe("/a");
    expect(running[0]?.sessionName).toBe("/a");
    const st = ap.map.get("/a");
    expect(st?.enabled).toBe(true);
    expect(st?.viaScheduler).toBe(true);
    expect(st?.goalQueue).toEqual(["fix-tests"]); // startCycleState seeded the goal-cycle
    expect(r1.tasks.find((t) => t.project === "/b")?.status).toBe("queued");
  });
});

describe("applyNotice", () => {
  it("a complete notice for a running task's session marks it done", () => {
    const r0 = run([task({ project: "/a", status: "running", sessionName: "sess-a" })]);
    const r1 = applyNotice(r0, { kind: "complete", session: "sess-a" });
    expect(r1.tasks[0]?.status).toBe("done");
  });
  it("ignores a notice whose session matches no running task", () => {
    const r0 = run([task({ project: "/a", status: "running", sessionName: "sess-a" })]);
    const r1 = applyNotice(r0, { kind: "complete", session: "other" });
    expect(r1.tasks[0]?.status).toBe("running");
  });
});
