import { describe, expect, it } from "vitest";
import { tasksToAdmit } from "../../src/core/scheduler/admission.js";
import type { PoolState, TaskState } from "../../src/core/scheduler/types.js";

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
const pools: Record<string, PoolState> = { claude: { paused: false }, codex: { paused: false } };

describe("tasksToAdmit", () => {
  it("admits up to the per-agent cap, counting already-running", () => {
    const tasks = [
      task({ project: "/a", status: "running" }),
      task({ project: "/b" }),
      task({ project: "/c" }),
    ];
    const admit = tasksToAdmit(tasks, { claude: 2 }, pools);
    expect(admit.map((t) => t.project)).toEqual(["/b"]); // 1 running + 1 = cap 2
  });

  it("orders queued by priority (desc) and respects separate pools", () => {
    const tasks = [
      task({ project: "/lo", priority: 1 }),
      task({ project: "/hi", priority: 9 }),
      task({ project: "/cx", agent: "codex", priority: 0 }),
    ];
    const admit = tasksToAdmit(tasks, { claude: 1, codex: 1 }, pools);
    expect(admit.map((t) => t.project)).toEqual(["/hi", "/cx"]); // claude:1 → hi; codex:1 → cx
  });

  it("skips a paused pool and an agent with no cap", () => {
    const tasks = [task({ project: "/a" }), task({ project: "/x", agent: "codex" })];
    const paused = { claude: { paused: true }, codex: { paused: false } };
    expect(tasksToAdmit(tasks, { claude: 3 }, paused).map((t) => t.project)).toEqual([]); // claude paused, codex no cap
  });

  it("admits nothing from an empty task list", () => {
    expect(tasksToAdmit([], { claude: 1 }, pools)).toEqual([]); // empty/all-done run boundary
  });
});
