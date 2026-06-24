import { describe, expect, it, vi } from "vitest";
import { type AutopilotState, defaultState } from "../../src/core/autopilot/types.js";
import { schedulerTick, type TickCtx } from "../../src/core/scheduler/scheduler-loop.js";
import { materializeRun } from "../../src/core/scheduler/scheduling.js";
import type { Plan, PoolState, Run } from "../../src/core/scheduler/types.js";

function fakeAutopilot() {
  const map = new Map<string, AutopilotState>();
  return {
    map,
    get: (s: string) => map.get(s) ?? defaultState(),
    set: (s: string, st: AutopilotState) => void map.set(s, st),
  };
}

const plan: Plan = {
  id: "p",
  name: "n",
  pools: { claude: 1 },
  projects: [
    { path: "/a", agent: "claude", goals: ["fix-tests"] },
    { path: "/b", agent: "claude", goals: ["fix-tests"] },
  ],
};

function ctx(over: Partial<TickCtx>): TickCtx {
  return {
    now: 1000,
    plans: [plan],
    run: undefined,
    pools: { claude: { paused: false } } as Record<string, PoolState>,
    lastFired: {},
    autopilot: fakeAutopilot(),
    resolveSession: (t) => t.sessionName ?? t.project,
    readUsage: async () => null,
    isGated: () => false,
    quotaPct: 99,
    reprobeMs: 1_800_000,
    save: () => {},
    notify: () => {},
    ...over,
  };
}

describe("schedulerTick — plan firing & finalize branches", () => {
  it("saves and returns without a run when no plan is due", async () => {
    let savedRun: Run | undefined | "unset" = "unset";
    const c = ctx({
      // an "at" schedule far in the future → nextFire is after `now` → not due
      plans: [{ ...plan, schedule: { kind: "at", at: 999_999_999_999 } }],
      save: (run) => {
        savedRun = run;
      },
    });
    await schedulerTick(c);
    expect(savedRun).toBeUndefined();
  });

  it("materializes a due 'at' plan into a run", async () => {
    let savedRun: Run | undefined;
    const c = ctx({
      now: 1000,
      plans: [{ ...plan, schedule: { kind: "at", at: 500 } }], // at <= now → due
      save: (run) => {
        savedRun = run;
      },
    });
    await schedulerTick(c);
    expect(savedRun?.planId).toBe("p");
    expect(savedRun?.tasks).toHaveLength(2);
  });

  it("finalizes a run once every task is terminal", async () => {
    const run = materializeRun(plan, "run-1", 1000);
    for (const t of run.tasks) t.status = "done";
    const notify = vi.fn();
    const c = ctx({ run, notify });
    await schedulerTick(c);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "batchRunComplete", runId: "run-1" }),
    );
  });
});
