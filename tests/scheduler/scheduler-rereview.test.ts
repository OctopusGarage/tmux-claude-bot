// Regression tests for the four confirmed bugs from the re-review pass.
//
// Bug #1: notifier applyNotice lost-update (drainNotices serializes application)
// Bug #2: /batch stop orphans sessions + leaves agents running (stopRun releases)
// Bug #3: dead session for running task hangs forever (liveness pass in tick)
// Bug #4: pools/run desync strands paused-quota tasks on restart (reconcilePools)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutopilotNotice } from "../../src/core/autopilot/notifier.js";
import { AutopilotStore } from "../../src/core/autopilot/state-store.js";
import { type AutopilotState, defaultState } from "../../src/core/autopilot/types.js";
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
// Bug #1 — notifier applyNotice lost-update
// ---------------------------------------------------------------------------

describe("Bug #1: drainNotices applies enqueued notices before processing", () => {
  it("a 'complete' notice in the queue causes the run to finish (batchRunComplete fired)", async () => {
    // A single running task + a "complete" notice already in the queue. The tick
    // must drain the notice, mark the task done, detect all-terminal, and fire
    // batchRunComplete. Without drainNotices the notice would be ignored and the
    // task would stay running forever.
    const run: Run = {
      runId: "r1",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [runningTask("/a", "sess_a")],
    };

    const noticeQueue: AutopilotNotice[] = [{ kind: "complete", session: "sess_a", goalId: "g1" }];
    const broadcasts: AutopilotNotice[] = [];

    const ctx = baseCtx({
      run,
      drainNotices: () => noticeQueue.splice(0),
      notify: (n) => broadcasts.push(n),
    });

    await schedulerTick(ctx);

    // The run reached all-terminal → batchRunComplete was broadcast.
    const complete = broadcasts.filter((n) => n.kind === "batchRunComplete");
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ kind: "batchRunComplete", runId: "r1" });
  });

  it("notice NOT in drainNotices (no drainNotices provided) → task stays running", async () => {
    // Confirms the baseline: without drainNotices the notice has no effect,
    // so the task stays running and no batchRunComplete is fired.
    const run: Run = {
      runId: "r1b",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [runningTask("/a", "sess_a")],
    };

    const broadcasts: AutopilotNotice[] = [];
    let savedRun: Run | undefined;

    const ctx = baseCtx({
      run,
      // No drainNotices — the old behaviour.
      notify: (n) => broadcasts.push(n),
      save: (r) => {
        savedRun = r;
      },
    });

    await schedulerTick(ctx);

    // No batchRunComplete — task is still running.
    expect(broadcasts.filter((n) => n.kind === "batchRunComplete")).toHaveLength(0);
    expect(savedRun?.tasks[0]?.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Bug #2 — /batch stop orphans sessions + leaves agents running
// ---------------------------------------------------------------------------

describe("Bug #2: stopRun releases non-terminal sessions", () => {
  it("running task session is disabled and viaScheduler cleared after stopRun", () => {
    const store = new SchedulerStore();
    const autopilot = new AutopilotStore();

    const run: Run = {
      runId: "r-stop",
      planId: "p",
      startedAt: Date.now(),
      status: "running",
      tasks: [runningTask("/a", "proj_1")],
    };
    store.setActiveRun(run);

    // Mark the session as scheduler-enrolled and enabled.
    autopilot.set("proj_1", {
      enabled: true,
      pureKeepAlive: false,
      persona: "conservative",
      iterations: 0,
      apiRetries: 0,
      recoveries: 0,
      viaScheduler: true,
    });

    stopRun(store, autopilot);

    const after = autopilot.get("proj_1");
    expect(after.enabled).toBe(false);
    expect(after.viaScheduler).toBe(false);
    // getActiveRun returns undefined after null is stored (JsonMapStore behaviour).
    expect(store.getActiveRun()).toBeFalsy();
  });

  it("terminal tasks are NOT touched by stopRun", () => {
    const store = new SchedulerStore();
    const autopilot = new AutopilotStore();

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
    autopilot.set("proj_done", {
      enabled: true,
      pureKeepAlive: false,
      persona: "conservative",
      iterations: 0,
      apiRetries: 0,
      recoveries: 0,
      viaScheduler: true,
    });

    stopRun(store, autopilot);

    // Terminal session must be untouched.
    const after = autopilot.get("proj_done");
    expect(after.enabled).toBe(true);
    expect(after.viaScheduler).toBe(true);
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
// Bug #3 — dead session for a running task hangs forever
// ---------------------------------------------------------------------------

describe("Bug #3: dead session for running task is failed/retried, not left running", () => {
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
// Bug #1/#9 — pool-paused DERIVED from the run every tick (no stale paused flag)
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

describe("Bug #1/#9: derivePools derives pool-paused purely from the run", () => {
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
describe("Bug #1/#9: stale paused pool does not block the next run's tasks", () => {
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

// ---------------------------------------------------------------------------
// Bug #5 — viaScheduler cleared on a session still used by a non-terminal task
// ---------------------------------------------------------------------------

describe("Bug #5: viaScheduler not cleared while another task on the same session is non-terminal", () => {
  it("shared session: one done + one running → viaScheduler stays true after tick", async () => {
    // Two tasks sharing the same sessionName, one terminal (done) and one still
    // running. The done task's iteration of the clearing loop must NOT clear
    // viaScheduler because the running task still needs the guard.
    const sharedSession = "shared_sess";
    const run: Run = {
      runId: "r5",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude" as const,
          goals: ["go"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done" as const,
          attempt: 0,
          goalsCompleted: ["go"],
          sessionName: sharedSession,
        },
        {
          project: "/b",
          agent: "claude" as const,
          goals: ["go"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "running" as const,
          attempt: 0,
          goalsCompleted: [],
          sessionName: sharedSession,
        },
      ],
    };

    const autopilot = fakeAutopilot();
    autopilot.set(sharedSession, { ...autopilot.get(sharedSession), viaScheduler: true });

    await schedulerTick(
      baseCtx({
        run,
        autopilot,
      }),
    );

    // The running task still holds the session — viaScheduler must NOT be cleared.
    expect(autopilot.get(sharedSession).viaScheduler).toBe(true);
  });

  it("single terminal task on session → viaScheduler IS cleared", async () => {
    // Baseline: when only ONE task uses the session and it's terminal, clearing works.
    const session = "solo_sess";
    const run: Run = {
      runId: "r5b",
      planId: "p",
      startedAt: 0,
      status: "running",
      tasks: [
        {
          project: "/a",
          agent: "claude" as const,
          goals: ["go"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "done" as const,
          attempt: 0,
          goalsCompleted: ["go"],
          sessionName: session,
        },
        {
          // Second task on a DIFFERENT session — must not affect the first.
          project: "/b",
          agent: "claude" as const,
          goals: ["go"],
          rounds: 1,
          retries: 0,
          priority: 0,
          status: "running" as const,
          attempt: 0,
          goalsCompleted: [],
          sessionName: "other_sess",
        },
      ],
    };

    const autopilot = fakeAutopilot();
    autopilot.set(session, { ...autopilot.get(session), viaScheduler: true });

    await schedulerTick(
      baseCtx({
        run,
        autopilot,
      }),
    );

    // Only solo_sess's task is terminal and no other task shares it → cleared.
    expect(autopilot.get(session).viaScheduler).toBe(false);
    // other_sess's running task must be unaffected.
    expect(autopilot.get("other_sess").viaScheduler).not.toBe(false);
  });
});
