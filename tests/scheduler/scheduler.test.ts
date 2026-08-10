// tests/scheduler/scheduler.test.ts
import { describe, expect, it } from "vitest";
import { reconcile } from "../../src/core/scheduler/scheduler.js";
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

describe("reconcile", () => {
  it("admits up to cap and marks admitted tasks running", () => {
    const r0 = run([task({ project: "/a" }), task({ project: "/b" })]);
    const r1 = reconcile(r0, { claude: 1 }, pools, {
      resolveSession: (t) => t.project,
      now: 1000,
    });
    const running = r1.tasks.filter((t) => t.status === "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.project).toBe("/a");
    expect(running[0]?.sessionName).toBe("/a");
    expect(r1.tasks.find((t) => t.project === "/b")?.status).toBe("queued");
  });

  it("does not let a gated higher-priority task consume capacity needed by an ungated task", () => {
    const r0 = run([task({ project: "/a", priority: 10 }), task({ project: "/b", priority: 1 })]);
    const resolved: string[] = [];
    const resolveSession = (t: TaskState) => {
      const session = `session:${t.project}`;
      resolved.push(session);
      return session;
    };

    const r1 = reconcile(r0, { claude: 1 }, pools, {
      resolveSession,
      isGated: (session) => session === "session:/a",
      now: 1000,
    });

    expect(r1.tasks.find((candidate) => candidate.project === "/a")).toMatchObject({
      status: "queued",
    });
    expect(r1.tasks.find((candidate) => candidate.project === "/b")).toMatchObject({
      status: "running",
      sessionName: "session:/b",
    });
    expect(resolved).toEqual(["session:/a", "session:/b"]);
  });
});
