// tests/scheduler/scheduler-notice.test.ts
import { describe, expect, it } from "vitest";
import { applyNotice, failOrRetry } from "../../src/core/scheduler/scheduler.js";
import type { Run, TaskState } from "../../src/core/scheduler/types.js";

const task = (over: Partial<TaskState>): TaskState => ({
  project: "/p",
  agent: "claude",
  goals: ["fix-tests"],
  rounds: 1,
  retries: 0,
  priority: 0,
  status: "running",
  attempt: 0,
  goalsCompleted: [],
  sessionName: "s",
  ...over,
});
const run = (t: TaskState): Run => ({
  runId: "r",
  planId: "p",
  startedAt: 0,
  status: "running",
  tasks: [t],
});

describe("applyNotice transitions", () => {
  it("awaitHuman → awaiting-human (frees the slot)", () => {
    const r = applyNotice(run(task({})), { kind: "awaitHuman", session: "s" });
    expect(r.tasks[0]?.status).toBe("awaiting-human");
  });
  it("maxIter with no retries left → failed", () => {
    const r = applyNotice(run(task({ retries: 0 })), {
      kind: "maxIter",
      session: "s",
    });
    expect(r.tasks[0]?.status).toBe("failed");
    expect(r.tasks[0]?.error).toContain("maxIter");
  });
  it("wallClock with a retry left → re-queued, attempt bumped, session cleared", () => {
    const r = applyNotice(run(task({ retries: 1, attempt: 0 })), {
      kind: "wallClock",
      session: "s",
    });
    expect(r.tasks[0]?.status).toBe("queued");
    expect(r.tasks[0]?.attempt).toBe(1);
    expect(r.tasks[0]?.sessionName).toBeUndefined();
  });
  it("ignores an unmatched session and a non-running task", () => {
    expect(applyNotice(run(task({})), { kind: "maxIter", session: "other" }).tasks[0]?.status).toBe(
      "running",
    );
    expect(
      applyNotice(run(task({ status: "queued" })), {
        kind: "maxIter",
        session: "s",
      }).tasks[0]?.status,
    ).toBe("queued");
  });
});

describe("failOrRetry", () => {
  it("retries while attempt < retries, then fails", () => {
    expect(failOrRetry(task({ retries: 2, attempt: 0 }), "x").status).toBe("queued");
    expect(failOrRetry(task({ retries: 2, attempt: 2 }), "x").status).toBe("failed");
  });
});
