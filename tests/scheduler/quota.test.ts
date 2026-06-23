import { describe, expect, it } from "vitest";
import type { UsageSnapshot } from "../../src/core/read/usage.js";
import {
  accountQuotaHit,
  pausePool,
  resumeAtFrom,
  resumePool,
} from "../../src/core/scheduler/quota.js";
import type { PoolState, Run, TaskState } from "../../src/core/scheduler/types.js";

const snap = (over: Partial<UsageSnapshot>): UsageSnapshot => ({
  sessionId: "s",
  contextPct: null,
  fiveHourPct: null,
  fiveHourReset: null,
  sevenDayPct: null,
  sevenDayReset: null,
  updatedAt: 0,
  ...over,
});
const task = (over: Partial<TaskState>): TaskState => ({
  project: "/p",
  agent: "claude",
  goals: [],
  rounds: 1,
  retries: 0,
  priority: 0,
  status: "running",
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

describe("accountQuotaHit", () => {
  it("true when a pct meets the threshold, false otherwise / when null", () => {
    expect(accountQuotaHit(snap({ fiveHourPct: 99 }), 99)).toBe(true);
    expect(accountQuotaHit(snap({ sevenDayPct: 100 }), 99)).toBe(true);
    expect(accountQuotaHit(snap({ fiveHourPct: 50 }), 99)).toBe(false);
    expect(accountQuotaHit(null, 99)).toBe(false);
  });
});
describe("resumeAtFrom", () => {
  it("earliest future reset (sec→ms), else now + reprobe", () => {
    const now = 1_000_000;
    expect(resumeAtFrom(snap({ fiveHourReset: 2000, sevenDayReset: 5000 }), now, 9)).toBe(
      2000 * 1000,
    );
    expect(resumeAtFrom(snap({ fiveHourReset: 1 }), now, 9)).toBe(now + 9); // reset in the past → reprobe
    expect(resumeAtFrom(null, now, 9)).toBe(now + 9);
  });
});
describe("pausePool / resumePool", () => {
  it("pauses the pool: running claude → paused-quota, queued stays queued; codex untouched", () => {
    const r0 = run([
      task({ project: "/run", status: "running" }),
      task({ project: "/queue", status: "queued" }),
      task({ agent: "codex", status: "running" }),
    ]);
    const pools: Record<string, PoolState> = {
      claude: { paused: false },
      codex: { paused: false },
    };
    const { run: r1, pools: p1 } = pausePool(r0, pools, "claude", 7);
    expect(p1.claude).toEqual({ paused: true, resumeAt: 7 });
    expect(r1.tasks.find((t) => t.project === "/run")?.status).toBe("paused-quota"); // slot freed
    expect(r1.tasks.find((t) => t.project === "/queue")?.status).toBe("queued"); // pool flag blocks it
    expect(r1.tasks.find((t) => t.agent === "codex")?.status).toBe("running");
  });
  it("a never-started queued task is NOT marked resuming after a pause/resume cycle", () => {
    // Pool cap >= 2 (e.g. max-3-claude): a running + a queued claude task. Quota pauses
    // the pool. Only the running-origin task carries progress; the queued one must come
    // back admittable FRESH, not resuming (it has no goal-cycle to continue).
    const r0 = run([
      task({ project: "/run", status: "running" }),
      task({ project: "/queue", status: "queued" }),
    ]);
    const { run: r1, pools: p1 } = pausePool(r0, { claude: { paused: false } }, "claude", 100);
    const { run: r2 } = resumePool(r1, p1, "claude", 100);
    const runOrigin = r2.tasks.find((t) => t.project === "/run");
    const queueOrigin = r2.tasks.find((t) => t.project === "/queue");
    expect(runOrigin?.status).toBe("queued");
    expect(runOrigin?.resuming).toBe(true); // had progress → resume without reset
    expect(queueOrigin?.status).toBe("queued");
    expect(queueOrigin?.resuming).not.toBe(true); // never started → fresh admit, no false resume
  });
  it("resumes at the reset time: pool unpaused, paused-quota → queued", () => {
    const r0 = run([task({ status: "paused-quota" })]);
    const pools: Record<string, PoolState> = { claude: { paused: true, resumeAt: 100 } };
    expect(resumePool(r0, pools, "claude", 50).pools.claude?.paused).toBe(true); // not yet
    const { run: r2, pools: p2 } = resumePool(r0, pools, "claude", 100);
    expect(p2.claude?.paused).toBe(false);
    expect(r2.tasks[0]?.status).toBe("queued");
    expect(r2.tasks[0]?.resuming).toBe(true); // must preserve goal-cycle progress on resume
  });
});
