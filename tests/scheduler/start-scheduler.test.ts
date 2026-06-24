import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScheduler } from "../../src/core/scheduler/scheduler-loop.js";
import { SchedulerStore } from "../../src/core/scheduler/scheduler-store.js";
import type { Plan } from "../../src/core/scheduler/types.js";

const plan: Plan = {
  id: "p",
  name: "n",
  pools: { claude: 1 },
  projects: [{ path: "/a", agent: "claude", goals: ["fix-tests"] }],
  schedule: { kind: "now" },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tcb-startsched-"));
  process.env.TCB_STATE_DIR = dir;
  // Fake only the interval timers; leave Date.now real (the "now" schedule fires
  // on lastFired-undefined, not wall-clock).
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.TCB_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function makeDeps(tickMs: number) {
  const register = vi.fn();
  const broadcast = vi.fn(async () => {});
  const deps = {
    config: { scheduler: { tickMs, quotaPct: 90, reprobeMs: 1_800_000 } },
    bridge: { isPaneAlive: vi.fn(async () => true) },
    notifier: { register, broadcast },
    configResolver: {},
  } as never;
  return { deps, register, broadcast };
}

describe("startScheduler", () => {
  it("is a no-op when tickMs <= 0", () => {
    const { deps, register } = makeDeps(0);
    const stop = startScheduler(deps);
    expect(register).not.toHaveBeenCalled();
    expect(typeof stop).toBe("function");
    stop(); // safe to call the no-op stop
  });

  it("subscribes, ticks on the interval (materializing a due plan), and stop() clears the timer", async () => {
    new SchedulerStore().savePlan(plan); // a due "now" plan persisted in the state dir
    const { deps, register, broadcast } = makeDeps(1000);
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const stop = startScheduler(deps);
    expect(register).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // fire exactly one tick
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "batchRunStarted", planId: "p" }),
    );
    stop();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("the notifier subscription returns early when no run is active", async () => {
    const { deps, register } = makeDeps(1000);
    startScheduler(deps);
    const cb = register.mock.calls[0]?.[0] as (n: unknown) => Promise<void>;
    await expect(cb({ kind: "usage", session: "s1" })).resolves.toBeUndefined();
  });
});
