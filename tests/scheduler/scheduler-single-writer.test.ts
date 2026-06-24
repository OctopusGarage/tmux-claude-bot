import { describe, expect, it, vi } from "vitest";
import { type AutopilotState, defaultState } from "../../src/core/autopilot/types.js";
import { schedulerTick, type TickCtx } from "../../src/core/scheduler/scheduler-loop.js";
import type { Plan, PoolState, Run, TaskState } from "../../src/core/scheduler/types.js";

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
  projects: [{ path: "/a", agent: "claude", goals: ["fix-tests"] }],
};

function runningTask(over: Partial<TaskState> = {}): TaskState {
  return {
    project: "/a",
    agent: "claude",
    goals: ["fix-tests"],
    rounds: 1,
    retries: 0,
    priority: 0,
    status: "running",
    attempt: 0,
    goalsCompleted: [],
    sessionName: "/a",
    ...over,
  };
}

function activeRun(over: Partial<Run> = {}): Run {
  return {
    runId: "r-sw",
    planId: "p",
    startedAt: 0,
    status: "running",
    tasks: [runningTask()],
    ...over,
  };
}

function ctx(over: Partial<TickCtx>): TickCtx {
  return {
    now: 1000,
    plans: [plan],
    run: undefined,
    pools: { claude: { paused: false } } as Record<string, PoolState>,
    lastFired: {},
    autopilot: fakeAutopilot(),
    resolveSession: (t) => t.project,
    readUsage: async () => null,
    isGated: () => false,
    quotaPct: 99,
    reprobeMs: 1_800_000,
    save: () => {},
    notify: () => {},
    ...over,
  };
}

describe("schedulerTick single-writer (re-read guard)", () => {
  // (1) External STOP during the hoisted awaits: getActiveRun returns undefined
  // (the stop nulled the run + already released sessions). The in-flight tick
  // must NOT resurrect the run (save a non-null run) nor re-enable its sessions
  // via reconcile (autopilot.set to admit).
  it("does not resurrect or re-admit when a stop lands during awaits", async () => {
    const ap = fakeAutopilot();
    const setSpy = vi.spyOn(ap, "set");
    const saves: Array<Run | undefined> = [];
    const c = ctx({
      run: activeRun(),
      autopilot: ap,
      getActiveRun: () => undefined, // external stop landed during awaits
      isAlive: async () => true,
      readUsage: async () => null,
      save: (r) => void saves.push(r),
    });
    await schedulerTick(c);
    // No save wrote a non-null run (the run is not resurrected).
    expect(saves.filter((r) => r !== undefined)).toHaveLength(0);
    // reconcile never ran → no autopilot admission write.
    expect(setSpy).not.toHaveBeenCalled();
  });

  // (1b) External STOP+START during the awaits: the store now holds a DIFFERENT
  // run (same "running" status). The tick must adopt the new run, NOT resurrect
  // the stale snapshot (a status-only guard would clobber the new run).
  it("adopts a replacement run when a stop+start lands during awaits (runId changed)", async () => {
    const oldRun = activeRun({ runId: "r-old" });
    const newRun = activeRun({ runId: "r-new", tasks: [runningTask({ status: "queued" })] });
    let savedRun: Run | undefined;
    const c = ctx({
      run: oldRun,
      getActiveRun: () => newRun, // stop nulled r-old, start wrote r-new, both during awaits
      isAlive: async () => true,
      save: (r) => {
        savedRun = r;
      },
    });
    await schedulerTick(c);
    // The store keeps the NEW run, not the stale snapshot.
    expect(savedRun?.runId).toBe("r-new");
    // and the new run's queued task is driven (admitted), proving we worked on r-new.
    expect(savedRun?.tasks[0]?.status).toBe("running");
  });

  // (2) External PAUSE during the awaits: getActiveRun returns a paused copy.
  // The tick must adopt paused — save a paused run, admit nothing.
  it("adopts an external pause that lands during awaits", async () => {
    const run = activeRun({ tasks: [runningTask({ status: "queued" })] });
    const ap = fakeAutopilot();
    const setSpy = vi.spyOn(ap, "set");
    let savedRun: Run | undefined;
    const c = ctx({
      run,
      autopilot: ap,
      getActiveRun: () => ({ ...run, status: "paused" }),
      isAlive: async () => true,
      save: (r) => {
        savedRun = r;
      },
    });
    await schedulerTick(c);
    expect(savedRun?.status).toBe("paused");
    // queued task stays queued — nothing admitted to running.
    expect(savedRun?.tasks[0]?.status).toBe("queued");
    expect(setSpy).not.toHaveBeenCalled();
  });

  // (3) No external change: getActiveRun returns the same run. Normal admission
  // still works (a queued task on a free pool is promoted to running).
  it("admits normally when getActiveRun reports no external change", async () => {
    const run = activeRun({ tasks: [runningTask({ status: "queued" })] });
    let savedRun: Run | undefined;
    const c = ctx({
      run,
      getActiveRun: () => run,
      isAlive: async () => true,
      save: (r) => {
        savedRun = r;
      },
    });
    await schedulerTick(c);
    expect(savedRun?.tasks[0]?.status).toBe("running");
  });

  // (4) Usage pre-fetch still drives quota: a running task + over-threshold
  // readUsage → pool paused (same outcome as before, now via the pre-fetched map
  // consumed inside the await-free critical section).
  it("pauses the pool via the pre-fetched usage map when over threshold", async () => {
    const run = activeRun();
    const ap = fakeAutopilot();
    ap.set("/a", { ...ap.get("/a"), enabled: true });
    let savedPools: Record<string, PoolState> = {};
    const c = ctx({
      run,
      autopilot: ap,
      getActiveRun: () => run,
      isAlive: async () => true,
      readUsage: async () => ({
        sessionId: "x",
        contextPct: null,
        fiveHourPct: 99,
        fiveHourReset: null,
        sevenDayPct: null,
        sevenDayReset: null,
        updatedAt: 0,
      }),
      save: (_r, pools) => {
        savedPools = pools;
      },
    });
    await schedulerTick(c);
    expect(savedPools.claude?.paused).toBe(true);
    expect(ap.get("/a").enabled).toBe(false);
  });

  // Backward-compat: when getActiveRun is omitted the re-read is a no-op using
  // the start-of-tick snapshot, so a normal tick still admits.
  it("falls back to the snapshot when getActiveRun is omitted", async () => {
    const run = activeRun({ tasks: [runningTask({ status: "queued" })] });
    let savedRun: Run | undefined;
    const c = ctx({
      run,
      save: (r) => {
        savedRun = r;
      },
    });
    await schedulerTick(c);
    expect(savedRun?.tasks[0]?.status).toBe("running");
  });
});
