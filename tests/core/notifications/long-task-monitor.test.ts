import { describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../../../src/core/dashboard/dashboard.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";
import {
  LONG_TASK_CHECK_MS,
  LONG_TASK_THRESHOLD_MS,
  LongTaskMonitor,
  startLongTaskMonitor,
} from "../../../src/core/notifications/long-task-monitor.js";
import { OwnerActivityTracker } from "../../../src/core/notifications/owner-activity.js";

const THREE_MIN = 3 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session: "tmux_proj_api",
    label: "api",
    sessionKind: "regular",
    workspacePath: "/home/user/api",
    independentSlot: null,
    group: null,
    kind: "claude",
    running: true,
    busy: true,
    taskMs: FIVE_MIN + 1000,
    task: { key: "queue:task-1", startedAt: 0, source: "queue" },
    cumulativeBusyMs: FIVE_MIN + 1000,
    uptimeMs: 10 * FIVE_MIN,
    usage: null,
    ...overrides,
  };
}

function idleRow(): SessionRow {
  const r = row({ busy: false, cumulativeBusyMs: FIVE_MIN + 1000 });
  delete r.taskMs;
  return r;
}

describe("LongTaskMonitor", () => {
  it("keeps the default poll interval separate from the long-task threshold", () => {
    expect(LONG_TASK_CHECK_MS).toBe(FIVE_MIN);
    expect(LONG_TASK_THRESHOLD_MS).toBe(THREE_MIN);
  });

  it("does not gather dashboard snapshots when no notification channel is registered", async () => {
    const snapshots = vi.fn(async () => ({
      sessions: [row()],
      global: {},
      generatedAt: 0,
    }));
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: new NotificationGateway(),
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();

    expect(snapshots).not.toHaveBeenCalled();
  });

  it("notifies once when a task was busy beyond the threshold and later becomes idle", async () => {
    const telegram = vi.fn(async (_message: string, _req?: unknown) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [row()], global: {}, generatedAt: 0 })
      .mockResolvedValueOnce({
        sessions: [idleRow()],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    expect(telegram).not.toHaveBeenCalled();

    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls[0]?.[0]).toContain("api");
  });

  it("uses the default three-minute threshold when no override is provided", async () => {
    const telegram = vi.fn(async (_message: string, _req?: unknown) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [row({ taskMs: THREE_MIN + 1000, cumulativeBusyMs: THREE_MIN + 1000 })],
        global: {},
        generatedAt: THREE_MIN + 1000,
      })
      .mockResolvedValueOnce({
        sessions: [idleRow()],
        global: {},
        generatedAt: THREE_MIN + 2000,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it("includes the session and latest history in the completion notification", async () => {
    const telegram = vi.fn(async (_message: string, _req?: unknown) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [row()], global: {}, generatedAt: 0 })
      .mockResolvedValueOnce({
        sessions: [idleRow()],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const latestHistory = vi.fn(async () => "final assistant answer");
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      latestHistory,
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(latestHistory).toHaveBeenCalledWith("tmux_proj_api");
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls[0]?.[0]).toContain("latest history:");
    expect(telegram.mock.calls[0]?.[0]).toContain("final assistant answer");
    expect(telegram.mock.calls[0]?.[1]).toMatchObject({
      session: "tmux_proj_api",
      source: "long-task-monitor",
    });
  });

  it("still notifies when reading the latest history fails", async () => {
    const telegram = vi.fn(async (_message: string, _req?: unknown) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [row()], global: {}, generatedAt: 0 })
      .mockResolvedValueOnce({
        sessions: [idleRow()],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      latestHistory: async () => {
        throw new Error("transcript unavailable");
      },
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls[0]?.[0]).not.toContain("latest history:");
    expect(telegram.mock.calls[0]?.[1]).toMatchObject({
      session: "tmux_proj_api",
      source: "long-task-monitor",
    });
  });

  it("does not infer a long task from cumulative busy time between polling ticks", async () => {
    const telegram = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [row({ taskMs: FIVE_MIN - 1000, cumulativeBusyMs: 20 * FIVE_MIN })],
        global: {},
        generatedAt: FIVE_MIN - 1000,
      })
      .mockResolvedValueOnce({
        sessions: [row({ busy: false, cumulativeBusyMs: 20 * FIVE_MIN + 2000 })],
        global: {},
        generatedAt: FIVE_MIN + 1000,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).not.toHaveBeenCalled();
  });

  it("does not combine multiple short tasks in the same session into one long task", async () => {
    const telegram = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          row({
            taskMs: 2 * 60 * 1000,
            task: { key: "queue:short-1", startedAt: 0, source: "queue" },
            cumulativeBusyMs: 2 * 60 * 1000,
          }),
        ],
        global: {},
        generatedAt: 2 * 60 * 1000,
      })
      .mockResolvedValueOnce({
        sessions: [
          row({
            taskMs: 2 * 60 * 1000,
            task: { key: "queue:short-2", startedAt: 2 * 60 * 1000, source: "queue" },
            cumulativeBusyMs: 4 * 60 * 1000,
          }),
        ],
        global: {},
        generatedAt: 4 * 60 * 1000,
      })
      .mockResolvedValueOnce({
        sessions: [row({ busy: false, cumulativeBusyMs: 6 * 60 * 1000 })],
        global: {},
        generatedAt: 6 * 60 * 1000,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();
    await monitor.tick();

    expect(telegram).not.toHaveBeenCalled();
  });

  it("notifies an armed task when the session immediately starts a different task", async () => {
    const telegram = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          row({
            taskMs: FIVE_MIN + 1000,
            task: { key: "queue:long", startedAt: 0, source: "queue" },
            cumulativeBusyMs: FIVE_MIN + 1000,
          }),
        ],
        global: {},
        generatedAt: FIVE_MIN + 1000,
      })
      .mockResolvedValueOnce({
        sessions: [
          row({
            taskMs: 1000,
            task: { key: "queue:next", startedAt: FIVE_MIN + 1000, source: "queue" },
            cumulativeBusyMs: FIVE_MIN + 2000,
          }),
        ],
        global: {},
        generatedAt: FIVE_MIN + 2000,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it("notifies an armed task when the session disappears from the dashboard", async () => {
    const telegram = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [row()], global: {}, generatedAt: 0 })
      .mockResolvedValueOnce({
        sessions: [],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls[0]?.[0]).toContain("status: session disappeared");
  });

  it("does not notify an unarmed task when the session disappears from the dashboard", async () => {
    const telegram = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [row({ taskMs: FIVE_MIN - 1000, cumulativeBusyMs: FIVE_MIN - 1000 })],
        global: {},
        generatedAt: 0,
      })
      .mockResolvedValueOnce({
        sessions: [],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).not.toHaveBeenCalled();
  });

  it("uses the recent owner channel, then falls back to the other channel when delivery fails", async () => {
    const telegram = vi.fn(async (_message: string) => {
      throw new Error("telegram down");
    });
    const lark = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    gateway.register("lark", lark);
    const ownerActivity = new OwnerActivityTracker();
    ownerActivity.record("telegram");
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [row()], global: {}, generatedAt: 0 })
      .mockResolvedValueOnce({
        sessions: [idleRow()],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity,
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(lark).toHaveBeenCalledTimes(1);
  });

  it("sends to both channels when both are registered and no recent owner channel is known", async () => {
    const telegram = vi.fn(async (_message: string) => {});
    const lark = vi.fn(async (_message: string) => {});
    const gateway = new NotificationGateway();
    gateway.register("telegram", telegram);
    gateway.register("lark", lark);
    const snapshots = vi
      .fn()
      .mockResolvedValueOnce({ sessions: [row()], global: {}, generatedAt: 0 })
      .mockResolvedValueOnce({
        sessions: [idleRow()],
        global: {},
        generatedAt: FIVE_MIN,
      });
    const monitor = new LongTaskMonitor({
      snapshot: snapshots as never,
      notifications: gateway,
      ownerActivity: new OwnerActivityTracker(),
      thresholdMs: FIVE_MIN,
    });

    await monitor.tick();
    await monitor.tick();

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(lark).toHaveBeenCalledTimes(1);
  });

  it("starts a periodic monitor and returns a cleanup function", () => {
    const timer = { unref: vi.fn() };
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(timer as unknown as NodeJS.Timeout);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const stop = startLongTaskMonitor(
      {
        notifications: new NotificationGateway(),
        ownerActivity: new OwnerActivityTracker(),
      } as unknown as HandlerDeps,
      { checkMs: 123, thresholdMs: FIVE_MIN },
    );

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(123);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    stop();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
