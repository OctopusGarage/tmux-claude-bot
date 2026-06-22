import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Stub the same core collaborators as the sibling test (server-ops.test.ts) that
// we're not exercising here — only autopilot ops use real collaborators.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../../../src/adapters/control/client.js";
import { startControlServer } from "../../../src/adapters/control/server.js";
import { startCycleState } from "../../../src/core/autopilot/goals/goal-state.js";
import { NotifierRegistry } from "../../../src/core/autopilot/notifier.js";
import { AutopilotStore } from "../../../src/core/autopilot/state-store.js";
import { defaultState } from "../../../src/core/autopilot/types.js";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

vi.mock("../../../src/core/dashboard/dashboard.js", () => ({
  buildDashboard: vi.fn(async () => ({ sessions: [], global: { sessionCount: 0 } })),
}));
vi.mock("../../../src/core/projects/project-ops.js", () => ({
  recentProjectButtons: vi.fn(async () => []),
  openRecentProjectBySid: vi.fn(async () => ({ status: "not-found" })),
}));
vi.mock("../../../src/core/command/dispatch.js", () => ({
  performStart: vi.fn(async () => "running"),
}));
vi.mock("../../../src/core/recovery/recover.js", () => ({
  recoverProjects: vi.fn(async () => ({ launched: [], shellOnly: [], alreadyAlive: [] })),
}));
vi.mock("../../../src/core/logs/log-query.js", () => ({ queryLogs: vi.fn(() => []) }));
vi.mock("../../../src/core/logs/logs-view.js", () => ({
  logsArgToFilter: vi.fn(() => null),
  formatLogsForChat: vi.fn(() => "LOGTEXT"),
}));
vi.mock("../../../src/core/infra/system-load.js", () => ({
  defaultSystemLoadProbes: vi.fn(() => ({})),
  gatherSystemLoad: vi.fn(async () => ({})),
  renderSystemLoad: vi.fn(() => "SYSLOAD"),
}));
vi.mock("../../../src/core/read/recent-inputs.js", () => ({
  getRecentInputs: vi.fn(async () => []),
}));
vi.mock("../../../src/core/session/output.js", () => ({
  renderPeekPane: vi.fn((snap: string) => snap),
}));
vi.mock("../../../src/core/projects/sessionPathMap.js", () => ({
  getPathBySession: vi.fn(() => undefined),
}));

type EnqueueVerdict = "queued" | "duplicate" | false;
function fakeDeps(
  notifier?: NotifierRegistry,
  enqueue?: (m: QueuedMessage) => EnqueueVerdict,
): HandlerDeps {
  return {
    config: { autopilot: { maxRounds: 10 } },
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
    notifier: notifier ?? new NotifierRegistry(),
  } as unknown as HandlerDeps;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("control autopilot ops (real unix socket)", () => {
  let dir: string;
  let server: Server;
  let client: ControlClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tcb-ctlap-"));
    process.env.TCB_STATE_DIR = dir;
  });
  afterEach(async () => {
    client?.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TCB_STATE_DIR;
  });

  async function connected(deps = fakeDeps()): Promise<ControlClient> {
    server = startControlServer(deps);
    await settle();
    client = new ControlClient();
    await client.connect();
    return client;
  }

  it("autopilot verb 'on' enables the session and returns a status string", async () => {
    const c = await connected();
    const result = await c.autopilot("s2", "on");
    expect(result).toMatchObject({ status: expect.any(String) });
    expect(new AutopilotStore().get("s2").enabled).toBe(true);
  });

  it("autopilotView returns the view with mode 'cycle' after startCycleState", async () => {
    // Set up cycle state before connecting
    new AutopilotStore().set(
      "s1",
      startCycleState(defaultState(), ["fix-tests", "code-review"], 2),
    );
    const c = await connected();
    const view = await c.autopilotView("s1");
    expect(view).toMatchObject({ mode: "cycle", enabled: true });
  });

  it("autopilotView returns mode 'off' for a session with no state", async () => {
    const c = await connected();
    const view = await c.autopilotView("unknown-session");
    expect(view).toMatchObject({ mode: "off", enabled: false });
  });

  it("push: autopilot notice broadcast reaches the client as an 'autopilot' event", async () => {
    const notifier = new NotifierRegistry();
    const c = await connected(fakeDeps(notifier));
    const received = new Promise<{ session: string; kind: string }>((resolve) => {
      c.once("autopilot", (msg: { session: string; kind: string }) => resolve(msg));
    });
    await notifier.broadcast({ kind: "awaitHuman", session: "s1", goalId: "g" });
    const evt = await received;
    expect(evt).toMatchObject({ session: "s1", kind: "awaitHuman" });
  });
});
