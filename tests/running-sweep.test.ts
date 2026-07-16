import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSessionRunning, markSessionRunning } from "../src/core/agents/runningSessions.js";
import { runRunningSweep, startRunningSweep } from "../src/core/recovery/running-sweep.js";
import { fakeDeps } from "./adapters/lark/_fakes.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-sweep-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runRunningSweep", () => {
  const BOOT = 1_000_000;

  it("reconciles live tmux, but keeps gone + pre-reboot bare-shell sessions for recovery", async () => {
    markSessionRunning("tmux_proj_a", BOOT + 100); // this boot, live + running → stays
    markSessionRunning("tmux_proj_b", BOOT + 100); // this boot, now a bare shell → dropped
    markSessionRunning("tmux_proj_c", BOOT + 100); // GONE from tmux (pending recovery) → untouched
    markSessionRunning("tmux_proj_e", BOOT - 100); // PRE-reboot, init recreated a bare shell → KEEP

    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => [
          "tmux_proj_a",
          "tmux_proj_b",
          "tmux_proj_d",
          "tmux_proj_e",
        ]),
      },
      agent: {
        // a and d have a live agent; b and e are bare shells.
        checkIfRunning: vi.fn(async (s?: string) => s === "tmux_proj_a" || s === "tmux_proj_d"),
      },
    });

    await runRunningSweep(deps, BOOT);

    expect(isSessionRunning("tmux_proj_a")).toBe(true); // live + running
    expect(isSessionRunning("tmux_proj_b")).toBe(false); // ran this boot, now a shell → stopped
    expect(isSessionRunning("tmux_proj_c")).toBe(true); // gone → left for recovery
    expect(isSessionRunning("tmux_proj_d")).toBe(true); // desktop-started → newly tracked
    expect(isSessionRunning("tmux_proj_e")).toBe(true); // pre-reboot bare shell → kept for /recover
  });

  it("treats a session-list failure as a skipped best-effort sweep", async () => {
    const checkIfRunning = vi.fn(async () => true);
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => {
          throw new Error("tmux unavailable");
        }),
      },
      agent: { checkIfRunning },
    });

    await expect(runRunningSweep(deps, BOOT)).resolves.toBeUndefined();

    expect(checkIfRunning).not.toHaveBeenCalled();
  });

  it("continues reconciling other live sessions when one agent check fails", async () => {
    const deps = fakeDeps({
      bridge: {
        listProjectSessions: vi.fn(async () => ["tmux_proj_bad", "tmux_proj_good"]),
      },
      agent: {
        checkIfRunning: vi.fn(async (session?: string) => {
          if (session === "tmux_proj_bad") throw new Error("pane unreadable");
          return true;
        }),
      },
    });

    await runRunningSweep(deps, BOOT);

    expect(isSessionRunning("tmux_proj_good")).toBe(true);
  });
});

describe("startRunningSweep", () => {
  it("does not schedule timers when disabled", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const stop = startRunningSweep(fakeDeps(), 0);
    stop();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("schedules an early first pass, interval pass, and cleanup", () => {
    const timeout = { unref: vi.fn() };
    const interval = { unref: vi.fn() };
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(timeout as unknown as NodeJS.Timeout);
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(interval as unknown as NodeJS.Timeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const stop = startRunningSweep(fakeDeps(), 60_000);

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(15_000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(60_000);
    expect(timeout.unref).toHaveBeenCalledTimes(1);
    expect(interval.unref).toHaveBeenCalledTimes(1);

    stop();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
