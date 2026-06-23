import { describe, expect, it } from "vitest";
import { resumeUngatedTasks } from "../../src/core/scheduler/resume.js";
import type { Run, TaskState } from "../../src/core/scheduler/types.js";

const task = (over: Partial<TaskState>): TaskState => ({
  project: "/p",
  agent: "claude",
  goals: [],
  rounds: 1,
  retries: 0,
  priority: 0,
  status: "awaiting-human",
  attempt: 0,
  goalsCompleted: [],
  sessionName: "s",
  ...over,
});
const run = (tasks: TaskState[]): Run => ({
  runId: "r",
  planId: "p",
  startedAt: 0,
  status: "running",
  tasks,
});

describe("resumeUngatedTasks", () => {
  it("re-queues an un-gated awaiting-human task with resuming=true", () => {
    const r = resumeUngatedTasks(run([task({ sessionName: "s" })]), () => false); // no longer gated
    expect(r.tasks[0]?.status).toBe("queued");
    expect(r.tasks[0]?.resuming).toBe(true);
  });
  it("leaves a still-gated task awaiting-human, and ignores other statuses", () => {
    const r = resumeUngatedTasks(
      run([task({ sessionName: "s" }), task({ status: "running", sessionName: "x" })]),
      (s) => s === "s",
    );
    expect(r.tasks[0]?.status).toBe("awaiting-human");
    expect(r.tasks[1]?.status).toBe("running");
  });
});
