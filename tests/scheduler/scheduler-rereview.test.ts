// Regression tests for the four confirmed bugs from the re-review pass.
//
// Bug #1: /batch stop clears the active run
// Bug #2: dead session for running task hangs forever (liveness pass in tick)
// Bug #3: pools/run desync strands paused-quota tasks on restart (reconcilePools)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopRun } from "../../src/core/scheduler/controls.js";
import {
  derivePools,
  schedulerTick,
  type TickCtx,
} from "../../src/core/scheduler/scheduler-loop.js";
import { SchedulerStore } from "../../src/core/scheduler/scheduler-store.js";
import type { Plan, PoolState, Run, TaskState } from "../../src/core/scheduler/types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const plan: Plan = {
  id: "p",
  name: "n",
  pools: { claude: 2 },
  projects: [
    { path: "/a", agent: "claude", goals: ["go"] },
    { path: "/b", agent: "claude", goals: ["go"] },
  ],
};

function baseCtx(over: Partial<TickCtx> = {}): TickCtx {
  return {
    now: 1000,
    plans: [plan],
    run: undefined,
    pools: {},
    lastFired: {},
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

function runningTask(project: string, session: string): Run["tasks"][0] {
  return {
    project,
    agent: "claude" as const,
    goals: ["go"],
    rounds: 1,
    retries: 0,
    priority: 0,
    status: "running" as const,
    attempt: 0,
    goalsCompleted: [],
    sessionName: session,
  };
}

// ---------------------------------------------------------------------------
// Env isolation
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-rr-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Bug #1 — /batch stop clears the active run
// ---------------------------------------------------------------------------

describe("Bug #1: stopRun clears active batch state", () => {
  it("clears a running active run", () => {
    const store = new SchedulerStore();

    const run: Run = {
      runId: "r-stop",
      planId: "p",
      startedAt: Date.now(),
      status: "running",
      tasks: [runningTask("/a", "proj_1")],
    };
    store.setActiveRun(run);

    stopRun(store);

    // getActiveRun returns undefined after null is stored (JsonMapStore behaviour).
    expect(store.getActiveRun()).toBeFalsy();
  });

  it("clears a terminal active run", () => {
    const store = new SchedulerStore();

    const run: Run = {
      runId: "r-terminal",
      planId: "p",
      startedAt: Date.now(),
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
          sessionName: "proj_done",
        },
      ],
    };
    store.setActiveRun(run);

    stopRun(store);

    expect(store.getActiveRun()).toBeFalsy();
  });

  it("stopRun is a no-op when no active run", () => {
    const store = new SchedulerStore();
    // Should not throw.
    stopRun(store);
    expect(store.getActiveRun()).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Bug #2 — dead session for a running task hangs forever
// ---------------------------------------------------------------------------

describe("Bug #2: dead session for running task is failed/retried, not left running", () => {
  it("task with dead session and no retries → failed after tick", async () => {
    // Two tasks: one dead, one live. The dead one must be failed; the live one untouched.
    const run: Run = {
      runId: "r-dead",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [runningTask("/a", "dead_sess"), runningTask("/b", "live_sess")],
    };

    let savedRun: Run | undefined;
    const ctx = baseCtx({
      run,
      isAlive: async (s) => s !== "dead_sess",
      save: (r) => {
        savedRun = r;
      },
    });

    await schedulerTick(ctx);

    const dead = savedRun?.tasks.find((t) => t.project === "/a");
    const live = savedRun?.tasks.find((t) => t.project === "/b");
    expect(dead?.status).toBe("failed");
    expect(dead?.error).toMatch(/dead session/i);
    expect(live?.status).toBe("running");
  });

  it("task with dead session and retries remaining → re-queued (attempt bumped, session cleared)", async () => {
    // Pool cap = 2. Fill both slots with live tasks + the dead task. After the
    // liveness pass the dead task becomes queued (attempt bumped). reconcile then
    // tries to re-admit it but the cap is full (two live tasks), so it stays queued.
    const planFull: Plan = {
      id: "p-full",
      name: "full",
      pools: { claude: 2 },
      projects: [
        { path: "/a", agent: "claude", goals: ["go"] },
        { path: "/b", agent: "claude", goals: ["go"] },
        { path: "/c", agent: "claude", goals: ["go"] },
      ],
    };
    const run: Run = {
      runId: "r-dead-retry",
      planId: "p-full",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          ...runningTask("/a", "dead_sess"),
          retries: 2,
          attempt: 0,
        },
        runningTask("/b", "live_1"),
        runningTask("/c", "live_2"),
      ],
    };

    let savedRun: Run | undefined;
    const ctx = baseCtx({
      plans: [planFull],
      run,
      isAlive: async (s) => s !== "dead_sess",
      save: (r) => {
        savedRun = r;
      },
    });

    await schedulerTick(ctx);

    const t = savedRun?.tasks.find((t) => t.project === "/a");
    // failOrRetry with attempt < retries → queued with bumped attempt + no session.
    expect(t?.status).toBe("queued");
    expect(t?.attempt).toBe(1);
    expect(t?.sessionName).toBeUndefined();
  });

  it("live running task is untouched by the liveness pass", async () => {
    const run: Run = {
      runId: "r-live",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [runningTask("/a", "live_sess"), runningTask("/b", "live_sess_2")],
    };

    let savedRun: Run | undefined;
    const ctx = baseCtx({
      run,
      isAlive: async () => true,
      save: (r) => {
        savedRun = r;
      },
    });

    await schedulerTick(ctx);

    // All tasks must still be running — liveness pass must not have touched them.
    expect(savedRun?.tasks.every((t) => t.status === "running")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bug #3/#9 — pool-paused DERIVED from the run every tick (no stale paused flag)
// ---------------------------------------------------------------------------

const NOW = 1_000_000;

function pausedQuotaTask(project: string): TaskState {
  return {
    project,
    agent: "claude",
    goals: ["go"],
    rounds: 1,
    retries: 0,
    priority: 0,
    status: "paused-quota",
    attempt: 0,
    goalsCompleted: [],
    sessionName: project,
  };
}

describe("Bug #3/#9: derivePools derives pool-paused purely from the run", () => {
  it("paused-quota claude task → {claude:{paused:true,resumeAt:preserved}}", () => {
    const RESUME_AT = 9_999_999;
    const run: Run = {
      runId: "r4c",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [pausedQuotaTask("/a")],
    };
    const result = derivePools({ claude: { paused: true, resumeAt: RESUME_AT } }, run, NOW);
    expect(result.claude?.paused).toBe(true);
    expect(result.claude?.resumeAt).toBe(RESUME_AT); // preserved from input
  });

  it("paused-quota task with no input resumeAt → stamps now", () => {
    const run: Run = {
      runId: "r4",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [pausedQuotaTask("/a")],
    };
    const result = derivePools({}, run, NOW);
    expect(result.claude?.paused).toBe(true);
    expect(result.claude?.resumeAt).toBe(NOW);
  });

  it("NO paused-quota task + input shows paused → cleared (empty)", () => {
    const run: Run = {
      runId: "r4d",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [runningTask("/a", "s")],
    };
    // A stale paused flag survives a stop/replace in the in-memory closure; with
    // no paused-quota task in the run it must be dropped entirely.
    const result = derivePools({ claude: { paused: true, resumeAt: 12345 } }, run, NOW);
    expect(result).toEqual({});
  });

  it("undefined run → {} (clears any stale paused)", () => {
    const result = derivePools({ claude: { paused: true, resumeAt: 12345 } }, undefined, NOW);
    expect(result).toEqual({});
  });
});

// Integration: a tick whose run has no paused-quota task but whose ctx.pools still
// shows claude paused (stale flag from a prior run) must ADMIT a queued claude task
// and the saved pools must no longer mark claude paused.
describe("Bug #3/#9: stale paused pool does not block the next run's tasks", () => {
  it("queued claude task is admitted despite a stale paused pool entry", async () => {
    const run: Run = {
      runId: "r-next",
      planId: "p",
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
          status: "queued",
          attempt: 0,
          goalsCompleted: [],
        },
      ],
    };
    let savedRun: Run | undefined;
    let savedPools: Record<string, PoolState> = {};
    const c = baseCtx({
      now: NOW,
      run,
      // stale paused flag with a FUTURE resumeAt — would block admission if trusted
      pools: { claude: { paused: true, resumeAt: NOW + 1_000_000 } },
      save: (r, p) => {
        savedRun = r;
        savedPools = p;
      },
    });
    await schedulerTick(c);
    expect(savedRun?.tasks[0]?.status).toBe("running"); // admitted, not blocked
    expect(savedPools.claude?.paused).toBeFalsy(); // stale flag cleared
  });
});
