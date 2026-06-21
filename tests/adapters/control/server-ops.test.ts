import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../../../src/adapters/control/client.js";
import { startControlServer } from "../../../src/adapters/control/server.js";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

// Stub the core collaborators each op delegates to — we're covering the control
// transport's DISPATCH + wiring, not re-testing dashboard/recovery/logs internals.
const h = vi.hoisted(() => ({
  openResult: { status: "switched", sessionName: "sOpen" } as unknown,
}));

vi.mock("../../../src/core/dashboard/dashboard.js", () => ({
  buildDashboard: vi.fn(async () => ({ sessions: [], global: { sessionCount: 0 } })),
}));
vi.mock("../../../src/core/projects/project-ops.js", () => ({
  recentProjectButtons: vi.fn(async () => [
    { sid: "p1", label: "Proj", alive: true, active: false },
  ]),
  openRecentProjectBySid: vi.fn(async () => h.openResult),
}));
vi.mock("../../../src/core/command/dispatch.js", () => ({
  performStart: vi.fn(async () => "running"),
}));
vi.mock("../../../src/core/recovery/recover.js", () => ({
  recoverProjects: vi.fn(async () => ({ launched: [1, 2], shellOnly: [3], alreadyAlive: [] })),
}));
vi.mock("../../../src/core/logs/log-query.js", () => ({ queryLogs: vi.fn(() => []) }));
vi.mock("../../../src/core/logs/logs-view.js", () => ({
  logsArgToFilter: vi.fn((_a: unknown, s: string) => (s ? { session: s } : null)),
  formatLogsForChat: vi.fn(() => "LOGTEXT"),
}));
vi.mock("../../../src/core/infra/system-load.js", () => ({
  defaultSystemLoadProbes: vi.fn(() => ({})),
  gatherSystemLoad: vi.fn(async () => ({})),
  renderSystemLoad: vi.fn(() => "SYSLOAD"),
}));
vi.mock("../../../src/core/read/recent-inputs.js", () => ({
  getRecentInputs: vi.fn(async () => ["input-a", "input-b"]),
}));
vi.mock("../../../src/core/session/output.js", () => ({
  renderPeekPane: vi.fn((snap: string) => snap),
}));
vi.mock("../../../src/core/projects/sessionPathMap.js", () => ({
  getPathBySession: vi.fn(() => undefined),
}));

type EnqueueVerdict = "queued" | "duplicate" | false;
function fakeDeps(enqueue?: (m: QueuedMessage) => EnqueueVerdict): HandlerDeps {
  return {
    bridge: { capturePaneColored: async (s: string) => `PANE for ${s}` },
    queue: {
      enqueue:
        enqueue ??
        ((m: QueuedMessage) => {
          setTimeout(() => m.resolve(`R:${m.action}:${m.text}`), 5);
          return "queued";
        }),
    },
    activity: { onActivity: () => () => {} },
  } as unknown as HandlerDeps;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("control server op dispatch (real unix socket)", () => {
  let dir: string;
  let server: Server;
  let client: ControlClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-ctlops-"));
    process.env.TCB_STATE_DIR = dir;
    h.openResult = { status: "switched", sessionName: "sOpen" };
  });
  afterEach(async () => {
    client?.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    process.env.TCB_STATE_DIR = undefined;
  });

  async function connected(deps = fakeDeps()): Promise<ControlClient> {
    server = startControlServer(deps);
    await settle();
    client = new ControlClient();
    await client.connect();
    return client;
  }

  it("handles every read-only op", async () => {
    const c = await connected();
    expect(await c.snapshot()).toMatchObject({ global: { sessionCount: 0 } });
    expect(await c.peek("sX", 5)).toContain("PANE for sX");
    expect(await c.projects()).toEqual([{ sid: "p1", label: "Proj", alive: true, active: false }]);
    expect(await c.recover()).toEqual({ launched: 2, shellOnly: 1, alreadyAlive: 0 });
    expect(await c.logs("sX")).toBe("LOGTEXT");
    expect(await c.sysload()).toBe("SYSLOAD");
    expect(await c.inputs("sX")).toEqual(["input-a", "input-b"]);
  });

  it("logs op returns 'no session' when the filter is empty", async () => {
    const c = await connected();
    expect(await c.logs("")).toBe("no session");
  });

  it("open: created/switched starts the agent; otherwise returns the raw result", async () => {
    const c = await connected();
    const switched = await c.open("p1");
    expect(switched).toMatchObject({ status: "switched", session: "sOpen", started: "running" });
    h.openResult = { status: "not-found" };
    expect(await c.open("nope")).toEqual({ status: "not-found" });
  });

  it("surfaces a handler throw as a failed response", async () => {
    const deps = fakeDeps();
    (deps.bridge as { capturePaneColored: () => Promise<string> }).capturePaneColored =
      async () => {
        throw new Error("pane boom");
      };
    const c = await connected(deps);
    await expect(c.peek("sX", 5)).rejects.toThrow("pane boom");
  });

  it("rejects with 'queue full' when the queue refuses the message", async () => {
    const c = await connected(fakeDeps(() => false));
    await expect(c.send("sX", "hi")).rejects.toThrow("queue full");
  });

  it("acks a deduped message as 'duplicate'", async () => {
    const c = await connected(fakeDeps(() => "duplicate"));
    expect(await c.send("sX", "dup")).toEqual({ status: "duplicate" });
  });

  it("pushes an activity event when the watcher fires", async () => {
    let fire: (() => void) | undefined;
    const deps = fakeDeps();
    (deps as { activity: { onActivity: (cb: () => void) => () => void } }).activity = {
      onActivity: (cb: () => void) => {
        fire = cb;
        return () => {};
      },
    };
    const c = await connected(deps);
    const activity = new Promise<void>((r) => c.once("activity", () => r()));
    fire?.();
    await activity; // resolves only if the server debounced + pushed the event
  });

  it("a request before connect rejects as 'not connected'", async () => {
    server = startControlServer(fakeDeps());
    await settle();
    const fresh = new ControlClient();
    await expect(fresh.snapshot()).rejects.toThrow("not connected");
  });
});
