import { describe, expect, it } from "vitest";
import { renderStatus, renderSummary } from "../../src/core/scheduler/report.js";
import type { Run, TaskState } from "../../src/core/scheduler/types.js";

const t = (over: Partial<TaskState>): TaskState => ({
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
const run = (tasks: TaskState[], over: Partial<Run> = {}): Run => ({
  runId: "r1",
  planId: "p",
  startedAt: 0,
  status: "running",
  tasks,
  ...over,
});

describe("renderStatus", () => {
  it("no run → friendly message", () => {
    expect(renderStatus(undefined)).toMatch(/no active batch/i);
  });
  it("lists each task with its status and project", () => {
    const s = renderStatus(
      run([
        t({
          project: "/a",
          status: "done",
          goalsCompleted: ["fix-tests"],
        }),
        t({ project: "/b", status: "running" }),
      ]),
    );
    expect(s).toContain("/a");
    expect(s).toContain("/b");
    expect(s).toContain("1/2"); // 1 of 2 done
  });
});
describe("renderSummary", () => {
  it("counts results and lists failures", () => {
    const s = renderSummary(
      run(
        [
          t({ status: "done" }),
          t({
            project: "/x",
            status: "failed",
            error: "maxIter",
          }),
        ],
        { status: "done", endedAt: 1000 },
      ),
    );
    expect(s).toMatch(/1 done/);
    expect(s).toMatch(/1 failed/);
    expect(s).toContain("/x");
    expect(s).toContain("maxIter");
  });
});
