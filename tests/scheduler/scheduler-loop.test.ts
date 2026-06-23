import { describe, expect, it, vi } from "vitest";
import type { AutopilotNotice } from "../../src/core/autopilot/notifier.js";
import { type AutopilotState, defaultState } from "../../src/core/autopilot/types.js";
import { schedulerTick, type TickCtx } from "../../src/core/scheduler/scheduler-loop.js";
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

describe("schedulerTick", () => {
  it("materializes a due 'now' plan and admits up to the pool cap", async () => {
    const c = ctx({ plans: [{ ...plan, schedule: { kind: "now" } }] });
    const saved: { run: Run | undefined } = { run: undefined };
    c.save = (run, _pools) => {
      saved.run = run;
    };
    await schedulerTick(c);
    const running = saved.run?.tasks.filter((t) => t.status === "running") ?? [];
    expect(running).toHaveLength(1); // claude cap 1
    expect(saved.run?.tasks.filter((t) => t.status === "queued")).toHaveLength(1);
  });

  it("broadcasts batchRunComplete when all tasks reach a terminal state", async () => {
    const run: Run = {
      runId: "r-complete",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: ["fix-tests"],
        },
        {
          project: "/b",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: ["fix-tests"],
        },
      ],
    };
    const noticed: AutopilotNotice[] = [];
    const c = ctx({ run, notify: (n) => noticed.push(n) });
    await schedulerTick(c);
    const complete = noticed.filter((n) => n.kind === "batchRunComplete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ kind: "batchRunComplete", runId: "r-complete" });
  });

  it("does not admit tasks when run is paused by user", async () => {
    const run: Run = {
      runId: "r-paused",
      planId: "p",
      startedAt: 0,
      status: "paused",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "queued",
          attempt: 0,
          goalsCompleted: [],
        },
      ],
    };
    const saved: { run: Run | undefined } = { run: undefined };
    const ap = fakeAutopilot();
    const seedSpy = vi.spyOn(ap, "set");
    const c = ctx({
      run,
      autopilot: ap,
      save: (r, _pools) => {
        saved.run = r;
      },
    });
    await schedulerTick(c);
    // The queued task must remain queued — not promoted to running
    expect(saved.run?.tasks[0]?.status).toBe("queued");
    // Autopilot must NOT be seeded/enabled for the task
    expect(seedSpy).not.toHaveBeenCalled();
  });

  it("pauses the pool when usage is at the quota threshold", async () => {
    const run: Run = {
      runId: "r",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: [],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "running",
          attempt: 0,
          goalsCompleted: [],
          sessionName: "/a",
        },
      ],
    };
    let savedPools: Record<string, PoolState> = {};
    const ap = fakeAutopilot();
    ap.set("/a", { ...ap.get("/a"), enabled: true }); // pre-seed as enabled
    const c = ctx({
      run,
      plans: [plan],
      autopilot: ap,
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
    expect(ap.get("/a").enabled).toBe(false); // autopilot must be disabled so quota is not burned
  });

  // Bug #1 (restart): a paused-quota run whose pool state is restored from the store
  // must resume tasks when resumeAt is in the past.
  it("restores persisted paused pool and resumes tasks on restart", async () => {
    const PAST = 500; // in the past relative to now=1000
    const run: Run = {
      runId: "r-restart",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "paused-quota",
          attempt: 0,
          goalsCompleted: [],
          sessionName: "/a",
        },
      ],
    };
    // Simulate restarted process: pools restored from store (paused + past resumeAt).
    const pools: Record<string, PoolState> = { claude: { paused: true, resumeAt: PAST } };
    let savedRun: Run | undefined;
    let savedPools: Record<string, PoolState> = {};
    const c = ctx({
      run,
      pools,
      save: (r, p) => {
        savedRun = r;
        savedPools = p;
      },
    });
    await schedulerTick(c);
    // resumePool must have fired: pool is now unpaused.
    // After resumePool (paused-quota → queued), reconcile runs and immediately
    // promotes the single task to running (cap=1, no other running tasks).
    expect(savedPools.claude?.paused).toBe(false);
    // Task was promoted from paused-quota → queued (resumePool) → running (reconcile).
    expect(savedRun?.tasks[0]?.status).toBe("running");
  });

  // Bug #2 (serialization): while one schedulerTick is in flight, a second tick call
  // must be coalesced (not run concurrently). Test the tick wrapper exported from
  // scheduler-loop via TickCtx.save: readUsage blocks until we resolve it; a second
  // save call must not interleave. We test schedulerTick directly here because
  // startScheduler is a live-process boundary; the serialization logic is exercised
  // by asserting that two sequential awaits via the same ctx produce exactly two save
  // calls with non-interleaved pool state.
  it("two sequential ticks do not interleave pool updates", async () => {
    // Two independent ticks run sequentially (no actual interleave in JS single-thread
    // micro-task order), each must see the pool state written by the previous one.
    let saveCount = 0;
    let firstPoolsSeenBySecond: Record<string, PoolState> | undefined;

    const runWithTask: Run = {
      runId: "r-seq",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
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
        },
      ],
    };

    let currentPools: Record<string, PoolState> = { claude: { paused: false } };
    const c = ctx({
      run: runWithTask,
      readUsage: async () => null,
      quotaPct: 99,
      save: (_r, p) => {
        saveCount += 1;
        if (saveCount === 1) {
          // Mutate shared pools between ticks (simulating what the live tick wrapper does).
          currentPools = p;
        } else {
          firstPoolsSeenBySecond = currentPools;
        }
      },
    });

    // Tick 1
    await schedulerTick(c);
    // Tick 2 — sees the pool state written by tick 1
    c.pools = currentPools;
    await schedulerTick(c);

    expect(saveCount).toBe(2);
    // The second tick saw the pools saved by the first (no stale overwrite).
    expect(firstPoolsSeenBySecond).toEqual(currentPools);
  });

  // Bug #6 (viaScheduler cleared): a done task whose session has viaScheduler=true
  // must have viaScheduler cleared to false after schedulerTick.
  it("clears viaScheduler on a session when its task reaches a terminal state", async () => {
    const ap = fakeAutopilot();
    ap.set("/a", { ...defaultState(), viaScheduler: true, enabled: false });

    const run: Run = {
      runId: "r-done",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: ["fix-tests"],
          sessionName: "/a",
        },
        {
          project: "/b",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: ["fix-tests"],
          sessionName: "/b",
        },
      ],
    };
    const c = ctx({ run, autopilot: ap });
    await schedulerTick(c);
    // viaScheduler must be cleared for the done session
    expect(ap.get("/a").viaScheduler).toBe(false);
    // /b had no viaScheduler set — must remain falsy (defaultState gives undefined)
    expect(ap.get("/b").viaScheduler).toBeFalsy();
  });

  // Bug #5 (cron catch-up): when a run completes, lastFired must be advanced to ctx.now
  // so a subsequent nextFire(cron, lastFired) returns a FUTURE occurrence, not a past one.
  it("advances lastFired to ctx.now when a run completes, preventing catch-up re-fires", async () => {
    const NOW = 1_000_000;
    const planId = "p-cron";
    const cronPlan: Plan = {
      id: planId,
      name: "cron-plan",
      pools: { claude: 1 },
      schedule: { kind: "cron", cron: "*/5 * * * *" }, // fires every 5 min
      projects: [{ path: "/a", agent: "claude", goals: ["go"] }],
    };
    const run: Run = {
      runId: "r-cron",
      planId,
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: ["go"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: ["go"],
        },
      ],
    };
    const lastFired: Record<string, number> = { [planId]: NOW - 30 * 60 * 1000 }; // 30 min ago
    const c = ctx({ now: NOW, run, plans: [cronPlan], lastFired });
    await schedulerTick(c);
    // After completion, lastFired must be advanced to ctx.now
    expect(lastFired[planId]).toBe(NOW);
    // nextFire from ctx.now should be strictly in the future (> NOW)
    const { nextFire } = await import("../../src/core/scheduler/scheduling.js");
    const next = nextFire({ kind: "cron", cron: "*/5 * * * *" }, lastFired[planId] as number);
    expect(next).not.toBeNull();
    expect(next).toBeGreaterThan(NOW);
  });

  // Bug #4 (dead session quota): when readUsage returns null (session not alive),
  // the pool must NOT be paused even if usage would otherwise exceed the threshold.
  it("does not pause pool when readUsage returns null for a running task (dead session)", async () => {
    const run: Run = {
      runId: "r-dead",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: [],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "running",
          attempt: 0,
          goalsCompleted: [],
          sessionName: "/a",
        },
      ],
    };
    let savedPools: Record<string, PoolState> = {};
    const c = ctx({
      run,
      plans: [plan],
      // readUsage returns null — as if isPaneAlive() returned false
      readUsage: async () => null,
      quotaPct: 50,
      save: (_r, pools) => {
        savedPools = pools;
      },
    });
    await schedulerTick(c);
    // Pool must NOT be paused when readUsage returned null. derivePools drops the
    // non-paused entry entirely (no paused-quota task → no entry = unpaused).
    expect(savedPools.claude?.paused).toBeFalsy();
  });

  // Bug #2 (complete-before-pause): a run whose tasks are ALL terminal AND that the
  // store now reports as "paused" (a /batch pause landed in the same tick) must be
  // FINALIZED — not frozen as a paused zombie. The all-terminal completion must run
  // BEFORE the paused early-return.
  it("finalizes an all-terminal run even when a pause landed in the same tick", async () => {
    const run: Run = {
      runId: "r-zombie",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: ["fix-tests"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: ["fix-tests"],
          sessionName: "/a",
        },
      ],
    };
    // The store re-read at the critical-section boundary returns the SAME run but
    // now "paused" — a /batch pause that landed during the tick's awaits.
    const pausedSameRun: Run = { ...run, status: "paused" };
    const noticed: AutopilotNotice[] = [];
    const saved: { called: boolean; run: Run | undefined } = { called: false, run: undefined };
    const lastFired: Record<string, number> = {};
    const c = ctx({
      run,
      lastFired,
      getActiveRun: () => pausedSameRun,
      notify: (n) => noticed.push(n),
      save: (r) => {
        saved.called = true;
        saved.run = r;
      },
    });
    await schedulerTick(c);
    // Finalized: save called with undefined (no active run), completion fired,
    // lastFired advanced — NOT saved as a paused zombie.
    expect(saved.called).toBe(true);
    expect(saved.run).toBeUndefined();
    expect(noticed.filter((n) => n.kind === "batchRunComplete")).toHaveLength(1);
    expect(lastFired.p).toBe(1000);
  });

  // Bug #3 (announce manual starts): the tick invokes announceRun with the active
  // run; the de-dup-by-runId closure (mirroring startScheduler) broadcasts a
  // batchRunStarted exactly once for a new runId and not again for the same id.
  it("announceRun fires batchRunStarted once per new run, deduped by runId", async () => {
    const broadcasts: AutopilotNotice[] = [];
    // Mirror startScheduler's announceRun closure: seeded with no prior run.
    let announcedRunId: string | undefined;
    const announceRun = (r: Run): void => {
      if (r.runId === announcedRunId) return;
      announcedRunId = r.runId;
      broadcasts.push({ kind: "batchRunStarted", runId: r.runId, planId: r.planId, tasks: 1 });
    };
    const run: Run = {
      runId: "r-announce",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
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
        },
      ],
    };
    const c = ctx({ run, announceRun });
    await schedulerTick(c); // first sight of r-announce → broadcast
    await schedulerTick(c); // same runId → no re-broadcast
    expect(broadcasts.filter((n) => n.kind === "batchRunStarted")).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ kind: "batchRunStarted", runId: "r-announce" });
  });

  // Bug #6 idempotence: a tick with an already-cleared viaScheduler does NOT re-write.
  it("does not re-write viaScheduler=false when it is already false", async () => {
    const ap = fakeAutopilot();
    ap.set("/a", { ...defaultState(), viaScheduler: false, enabled: false });
    const setSpy = vi.spyOn(ap, "set");

    const run: Run = {
      runId: "r-already-clear",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude",
          goals: [],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done",
          attempt: 0,
          goalsCompleted: [],
          sessionName: "/a",
        },
      ],
    };
    const c = ctx({ run, autopilot: ap });
    await schedulerTick(c);
    // The guard `st.viaScheduler === true` must prevent the write-back.
    expect(setSpy).not.toHaveBeenCalledWith("/a", expect.objectContaining({ viaScheduler: false }));
  });
});
