import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectPathToHistoryDir } from "../../src/core/agents/claude/claude-history.js";
import { markSessionUsed, sessionLastUsedAt } from "../../src/core/agents/runningSessions.js";
import { setPathForSession } from "../../src/core/projects/sessionPathMap.js";
import {
  runSessionIdleReaper,
  startSessionIdleReaper,
} from "../../src/core/recovery/session-idle-reaper.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-idle-reaper-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runSessionIdleReaper", () => {
  const now = 10_000_000;
  const maxIdleMs = 3_000;

  it("closes only long-idle non-current user project agents", async () => {
    setPathForSession("tmux_proj_current", "/repo/current");
    setPathForSession("tmux_proj_stale", "/repo/stale");
    setPathForSession("tmux_proj_fresh", "/repo/fresh");
    setPathForSession("tmux_proj_loop-supervisor-1", "/repo/supervisor");
    markSessionUsed("tmux_proj_current", now - 10_000);
    markSessionUsed("tmux_proj_stale", now - 10_000);
    markSessionUsed("tmux_proj_fresh", now - 100);
    markSessionUsed("tmux_proj_loop-supervisor-1", now - 10_000);

    const exit = vi.fn(async () => {});
    const deps = fakeDeps({
      currentProject: { allCurrent: vi.fn(async () => ["tmux_proj_current"]) },
      bridge: {
        listProjectSessions: vi.fn(async () => [
          "tmux_proj_current",
          "tmux_proj_stale",
          "tmux_proj_fresh",
          "tmux_proj_loop-supervisor-1",
        ]),
        paneCurrentPath: vi.fn(async (session?: string) =>
          session === "tmux_proj_stale" ? "/repo/stale" : "/repo/fresh",
        ),
      },
      agent: {
        checkIfRunning: vi.fn(async () => true),
        exit,
      },
    });

    const summary = await runSessionIdleReaper(deps, { now, maxIdleMs });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith("tmux_proj_stale");
    expect(summary).toMatchObject({
      checked: 3,
      closed: 1,
      skipped: { current: 1, "not-idle-long-enough": 1 },
      failures: 0,
    });
  });

  it("kills long-idle loop worker tmux sessions instead of routing them to user chat cleanup", async () => {
    setPathForSession("tmux_proj_loop-worker-api", "/repo/api");
    setPathForSession("tmux_proj_loop-supervisor-1", "/repo/supervisor");
    markSessionUsed("tmux_proj_loop-worker-api", now - 10_000);
    markSessionUsed("tmux_proj_loop-supervisor-1", now - 10_000);

    const exit = vi.fn(async () => {});
    const killSession = vi.fn(async () => {});
    const deps = fakeDeps({
      session: null,
      bridge: {
        listProjectSessions: vi.fn(async () => [
          "tmux_proj_loop-worker-api",
          "tmux_proj_loop-supervisor-1",
        ]),
        paneCurrentPath: vi.fn(async () => "/repo/api"),
        killSession,
      },
      agent: {
        checkIfRunning: vi.fn(async () => true),
        exit,
      },
    });

    const summary = await runSessionIdleReaper(deps, { now, maxIdleMs });

    expect(killSession).toHaveBeenCalledWith("tmux_proj_loop-worker-api");
    expect(exit).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      checked: 1,
      closed: 1,
      failures: 0,
    });
  });

  it("kills stale stopped loop worker tmux sessions after the idle threshold", async () => {
    setPathForSession("tmux_proj_loop-worker-api", "/repo/api");
    markSessionUsed("tmux_proj_loop-worker-api", now - 10_000);

    const killSession = vi.fn(async () => {});
    const deps = fakeDeps({
      session: null,
      bridge: {
        listProjectSessions: vi.fn(async () => ["tmux_proj_loop-worker-api"]),
        paneCurrentPath: vi.fn(async () => "/repo/api"),
        killSession,
      },
      agent: {
        checkIfRunning: vi.fn(async () => false),
        exit: vi.fn(async () => {}),
      },
    });

    const summary = await runSessionIdleReaper(deps, { now, maxIdleMs });

    expect(killSession).toHaveBeenCalledWith("tmux_proj_loop-worker-api");
    expect(summary.closed).toBe(1);
  });

  it("seeds unknown last-used timestamps instead of closing old untracked sessions", async () => {
    setPathForSession("tmux_proj_unknown", "/repo/unknown");
    const exit = vi.fn(async () => {});
    const deps = fakeDeps({
      session: null,
      bridge: {
        listProjectSessions: vi.fn(async () => ["tmux_proj_unknown"]),
        paneCurrentPath: vi.fn(async () => "/repo/unknown"),
      },
      agent: {
        checkIfRunning: vi.fn(async () => true),
        exit,
      },
    });

    const summary = await runSessionIdleReaper(deps, { now, maxIdleMs });

    expect(exit).not.toHaveBeenCalled();
    expect(sessionLastUsedAt("tmux_proj_unknown")).toBe(now);
    expect(summary.skipped).toEqual({ "unknown-last-used": 1 });
  });

  it("does not close queued, busy, drifted, or stopped sessions", async () => {
    for (const session of [
      "tmux_proj_queued",
      "tmux_proj_busy",
      "tmux_proj_drifted",
      "tmux_proj_stopped",
    ]) {
      setPathForSession(session, `/repo/${session}`);
      markSessionUsed(session, now - 10_000);
    }
    const exit = vi.fn(async () => {});
    const paneCaptures = new Map<string, string[]>([
      ["tmux_proj_busy", ["one", "two"]],
      ["tmux_proj_drifted", ["stable", "stable"]],
      ["tmux_proj_stopped", ["stable", "stable"]],
    ]);
    const deps = fakeDeps({
      session: null,
      queue: {
        size: vi.fn((session?: string) => (session === "tmux_proj_queued" ? 1 : 0)),
      },
      bridge: {
        listProjectSessions: vi.fn(async () => [
          "tmux_proj_queued",
          "tmux_proj_busy",
          "tmux_proj_drifted",
          "tmux_proj_stopped",
        ]),
        paneCurrentPath: vi.fn(async (session?: string) =>
          session === "tmux_proj_drifted" ? "/elsewhere" : `/repo/${session}`,
        ),
        capturePane: vi.fn(
          async (session?: string) => paneCaptures.get(session ?? "")?.shift() ?? "stable",
        ),
      },
      agent: {
        checkIfRunning: vi.fn(async (session?: string) => session !== "tmux_proj_stopped"),
        exit,
      },
    });

    const summary = await runSessionIdleReaper(deps, { now, maxIdleMs });

    expect(exit).not.toHaveBeenCalled();
    expect(summary.closed).toBe(0);
    expect(summary.skipped).toMatchObject({
      "queue-busy": 1,
      busy: 1,
      "path-drifted": 1,
      "not-running": 1,
    });
  });

  it("treats direct tmux agent transcript writes as session usage", async () => {
    const directNow = 1_000_000_000;
    const maxIdle = 259_200_000;
    const projectPath = "/repo/direct-tmux";
    const configRoot = join(dir, "claude-home");
    const historyDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(historyDir, { recursive: true });
    const transcriptPath = join(historyDir, "11111111-1111-1111-1111-111111111111.jsonl");
    fs.writeFileSync(transcriptPath, "\n", "utf-8");
    const directUseAt = directNow - 120_000;
    fs.utimesSync(transcriptPath, directUseAt / 1000, directUseAt / 1000);

    setPathForSession("tmux_proj_direct", projectPath);
    markSessionUsed("tmux_proj_direct", directNow - maxIdle * 2);
    const exit = vi.fn(async () => {});
    const deps = fakeDeps({
      session: null,
      bridge: {
        listProjectSessions: vi.fn(async () => ["tmux_proj_direct"]),
        paneCurrentPath: vi.fn(async () => projectPath),
      },
      configResolver: {
        resolveConfigRoot: vi.fn(async () => configRoot),
      },
      agent: {
        checkIfRunning: vi.fn(async () => true),
        exit,
      },
    });

    const summary = await runSessionIdleReaper(deps, { now: directNow, maxIdleMs: maxIdle });

    expect(exit).not.toHaveBeenCalled();
    expect(sessionLastUsedAt("tmux_proj_direct")).toBe(directUseAt);
    expect(summary.skipped).toEqual({ "not-idle-long-enough": 1 });
  });
});

describe("startSessionIdleReaper", () => {
  it("does not schedule timers when disabled", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const stop = startSessionIdleReaper(fakeDeps(), { tickMs: 0, maxIdleMs: 1 });
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

    const stop = startSessionIdleReaper(fakeDeps(), { tickMs: 120_000, maxIdleMs: 1 });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(60_000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(120_000);
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
