import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-tasktime-"));
  process.env.TCB_STATE_DIR = dir;
  vi.resetModules();
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("task-timing", () => {
  it("not busy with zero cumulative for an unknown session", async () => {
    const t = await import("../src/core/session/task-timing.js");
    expect(t.currentTask("s")).toEqual({ busy: false });
    expect(t.cumulativeBusyMs("s")).toBe(0);
  });

  it("tracks an in-flight task's duration while busy", async () => {
    const t = await import("../src/core/session/task-timing.js");
    t.taskStarted("s", 1000);
    expect(t.currentTask("s", 1500)).toEqual({ busy: true, sinceMs: 500, startedAt: 1000 });
    expect(t.cumulativeBusyMs("s", 1500)).toBe(500);
  });

  it("accrues cumulative on taskEnded and clears busy", async () => {
    const t = await import("../src/core/session/task-timing.js");
    t.taskStarted("s", 1000);
    t.taskEnded("s", 1500);
    expect(t.currentTask("s")).toEqual({ busy: false });
    expect(t.cumulativeBusyMs("s")).toBe(500);
    t.taskStarted("s", 2000);
    t.taskEnded("s", 2300);
    expect(t.cumulativeBusyMs("s")).toBe(800);
  });

  it("taskEnded without a start is a safe no-op (never negative)", async () => {
    const t = await import("../src/core/session/task-timing.js");
    t.taskEnded("s", 9999);
    expect(t.cumulativeBusyMs("s")).toBe(0);
  });

  it("persists cumulative across a fresh store load", async () => {
    const t1 = await import("../src/core/session/task-timing.js");
    t1.taskStarted("s", 1000);
    t1.taskEnded("s", 1400);
    const { JsonMapStore } = await import("../src/core/infra/json-map-store.js");
    expect(new JsonMapStore<number>("session_task_time.json").get("s")).toBe(400);
  });

  it("clearTaskTiming drops the record", async () => {
    const t = await import("../src/core/session/task-timing.js");
    t.taskStarted("s", 1000);
    t.taskEnded("s", 1400);
    t.clearTaskTiming("s");
    expect(t.cumulativeBusyMs("s")).toBe(0);
    expect(t.currentTask("s")).toEqual({ busy: false });
  });
});
