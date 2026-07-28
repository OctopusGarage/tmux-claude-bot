import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlClient } from "../../../src/adapters/control/client.js";
import { startControlServer } from "../../../src/adapters/control/server.js";
import { NotifierRegistry } from "../../../src/core/autopilot/notifier.js";
import { performStart } from "../../../src/core/command/dispatch.js";
import type { QueuedMessage } from "../../../src/core/command/queue.js";
import type { HandlerDeps } from "../../../src/core/deps.js";

// Stub the core collaborators each op delegates to — we're covering the control
// transport's DISPATCH + wiring, not re-testing dashboard/recovery/logs internals.
const h = vi.hoisted(() => ({
  openResult: { status: "switched", sessionName: "sOpen" } as unknown,
  openPathResult: { status: "created", sessionName: "sNew", projectPath: "/p" } as unknown,
  orphans: [
    { pid: 111, agent: "claude", busy: null },
    { pid: 222, agent: "codex", busy: true },
  ] as { pid: number; agent: "claude" | "codex"; busy: boolean | null }[],
  adoptOutcome: { ok: true, body: "adopted proj", sessionName: "sAdopt" } as {
    ok: boolean;
    body: string;
    sessionName: string;
  },
}));

vi.mock("../../../src/core/dashboard/dashboard.js", () => ({
  buildDashboard: vi.fn(async () => ({ sessions: [], global: { sessionCount: 0 } })),
}));
vi.mock("../../../src/core/projects/project-ops.js", () => ({
  recentProjectButtons: vi.fn(async () => [
    { sid: "p1", label: "Proj", alive: true, active: false },
  ]),
  openRecentProjectBySid: vi.fn(async () => h.openResult),
  createProjectFromPath: vi.fn(async () => h.openPathResult),
}));
vi.mock("../../../src/core/command/dispatch.js", () => ({
  performStart: vi.fn(async () => "running"),
}));
// Mock the takeover modules — the real ones inspect/kill live processes.
vi.mock("../../../src/core/agents/takeover.js", () => ({
  orphanBusyState: (o: { busy?: boolean | null }) =>
    o.busy === true ? "busy" : o.busy === false ? "idle" : "unknown",
  orphanLabel: (o: { pid: number; agent: string; busy?: boolean | null }) =>
    `${o.agent} pid=${o.pid} task=${o.busy === true ? "busy" : o.busy === false ? "idle" : "unknown"}`,
}));
vi.mock("../../../src/core/agents/takeover-service.js", () => ({
  findAdoptableOrphans: vi.fn(async () => h.orphans),
  adoptOrphan: vi.fn(async () => ({ ok: h.adoptOutcome.ok })),
  composeAdoptOutcome: vi.fn(() => h.adoptOutcome),
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
function fakeDeps(
  enqueue?: (m: QueuedMessage) => EnqueueVerdict,
  prefix = "tmux_proj_",
): HandlerDeps {
  return {
    bridge: { capturePaneColored: async (s: string) => `PANE for ${s}` },
    config: {
      projectSessionPrefix: prefix,
      claudeStartCommand: "claude",
      startCommands: [
        { label: "Claude", command: "claude", agent: "claude" },
        { label: "Codex", command: "codex", agent: "codex" },
      ],
    },
    queue: {
      enqueue:
        enqueue ??
        ((m: QueuedMessage) => {
          setTimeout(() => m.resolve(`R:${m.action}:${m.text}`), 5);
          return "queued";
        }),
    },
    activity: { onActivity: () => () => {} },
    notifier: new NotifierRegistry(),
    notifications: {
      notify: vi.fn(async () => ({
        status: "sent",
        deliveries: [{ channel: "telegram", ok: true }],
      })),
    },
    currentProject: { set: vi.fn(async () => {}) },
  } as unknown as HandlerDeps;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe("control server op dispatch (real unix socket)", () => {
  let dir: string;
  let server: Server;
  let client: ControlClient;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "tcb-ctlops-"));
    process.env.TCB_STATE_DIR = dir;
    h.openResult = { status: "switched", sessionName: "sOpen" };
    h.openPathResult = { status: "created", sessionName: "sNew", projectPath: "/p" };
    h.orphans = [
      { pid: 111, agent: "claude", busy: null },
      { pid: 222, agent: "codex", busy: true },
    ];
    h.adoptOutcome = { ok: true, body: "adopted proj", sessionName: "sAdopt" };
  });
  afterEach(async () => {
    client?.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    process.env.TCB_STATE_DIR = undefined;
    delete process.env.CONTROL_PROMPT_TRANSLATE_MODE;
    delete process.env.CONTROL_PROMPT_TRANSLATE_FROM;
    delete process.env.CONTROL_PROMPT_TRANSLATE_TO;
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

  it("routes notify through the notification gateway", async () => {
    const deps = fakeDeps();
    const c = await connected(deps);

    await expect(
      c.notify({
        channel: "both",
        level: "warning",
        source: "backup",
        title: "Backup slow",
        body: "database dump took 12m\nretry scheduled",
        session: "tmux_proj_api",
      }),
    ).resolves.toEqual({
      status: "sent",
      deliveries: [{ channel: "telegram", ok: true }],
    });
    expect(deps.notifications.notify).toHaveBeenCalledWith({
      channel: "both",
      level: "warning",
      source: "backup",
      title: "Backup slow",
      body: "database dump took 12m\nretry scheduled",
      session: "tmux_proj_api",
    });
  });

  it("routes notify attachments through the notification gateway", async () => {
    const deps = fakeDeps();
    const c = await connected(deps);

    await c.notify({
      channel: "lark",
      title: "Radar ready",
      attachments: [{ path: "/tmp/report.md" }, { path: "/tmp/report.html" }],
    });

    expect(deps.notifications.notify).toHaveBeenCalledWith({
      channel: "lark",
      title: "Radar ready",
      attachments: [{ path: "/tmp/report.md" }, { path: "/tmp/report.html" }],
    });
  });

  it("logs op returns 'no session' when the filter is empty", async () => {
    const c = await connected();
    expect(await c.logs("")).toBe("no session");
  });

  it("open: created/switched starts the agent; otherwise returns the raw result", async () => {
    const c = await connected();
    const switched = await c.open("p1");
    expect(switched).toMatchObject({ status: "switched", session: "sOpen", started: "running" });
    expect(performStart).toHaveBeenLastCalledWith(expect.anything(), "sOpen", undefined);
    await c.open("p1", { agent: "codex" });
    expect(performStart).toHaveBeenLastCalledWith(expect.anything(), "sOpen", "codex");
    h.openResult = { status: "not-found" };
    expect(await c.open("nope")).toEqual({ status: "not-found" });
  });

  it("openPath: created/switched starts the agent; invalid passes through", async () => {
    const c = await connected();
    const created = await c.openPath("/some/dir");
    expect(created).toMatchObject({ status: "created", session: "sNew", started: "running" });
    await c.openPath("/some/dir", { agent: "claude" });
    expect(performStart).toHaveBeenLastCalledWith(expect.anything(), "sNew", "claude");
    h.openPathResult = { status: "invalid", error: "not-allowed", resolvedPath: "/x" };
    expect(await c.openPath("/x")).toEqual({
      status: "invalid",
      error: "not-allowed",
      resolvedPath: "/x",
    });
  });

  it("orphans lists adoptable processes; adopt runs the takeover", async () => {
    const c = await connected();
    expect(await c.orphans()).toEqual([
      { pid: 111, agent: "claude", busy: "unknown", label: "claude pid=111 task=unknown" },
      { pid: 222, agent: "codex", busy: "busy", label: "codex pid=222 task=busy" },
    ]);
    expect(await c.adopt(111)).toEqual({ ok: true, body: "adopted proj", session: "sAdopt" });
    h.adoptOutcome = { ok: false, body: "target busy", sessionName: "" };
    expect(await c.adopt(222)).toEqual({ ok: false, body: "target busy" });
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

  it("send to the operator session is refused with a clear error", async () => {
    const c = await connected(fakeDeps(undefined, "tmux_proj_"));
    await expect(c.send("tmux_proj_home", "hello")).rejects.toThrow(
      "cannot send to the operator session",
    );
  });

  it("send to a normal project is NOT refused by the operator guard", async () => {
    const c = await connected(fakeDeps(undefined, "tmux_proj_"));
    const ack = await c.send("tmux_proj_myapp", "hello");
    expect(ack.status).toBe("queued");
  });

  it("handles prompt translation status and off through the control socket", async () => {
    process.env.CONTROL_PROMPT_TRANSLATE_MODE = "argos";
    process.env.CONTROL_PROMPT_TRANSLATE_FROM = "zh";
    process.env.CONTROL_PROMPT_TRANSLATE_TO = "en";
    const c = await connected();

    expect((await c.promptTranslate("status")).body).toContain("argos zh->en");
    expect((await c.promptTranslate("off")).body).toContain("disabled");
    expect(process.env.CONTROL_PROMPT_TRANSLATE_MODE).toBe("off");
  });

  it("transforms control user prompts before enqueueing and preserves source metadata", async () => {
    const fakePython = join(dir, "fake-python");
    writeFileSync(fakePython, "#!/bin/sh\ncat >/dev/null\nprintf 'Ship the feature'\n");
    chmodSync(fakePython, 0o755);
    const oldEnv = {
      mode: process.env.PROMPT_TRANSLATE_MODE,
      python: process.env.ARGOS_TRANSLATE_PYTHON,
    };
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    process.env.ARGOS_TRANSLATE_PYTHON = fakePython;
    const enqueued: QueuedMessage[] = [];

    try {
      const c = await connected(
        fakeDeps((m) => {
          enqueued.push(m);
          return "queued";
        }),
      );

      expect(await c.send("sX", "把功能做完")).toEqual({ status: "queued" });
      expect(enqueued[0]).toMatchObject({
        text: "Ship the feature",
        origin: "user",
        promptSource: "control",
        sourceText: "把功能做完",
        transform: { kind: "translation", provider: "argos", from: "zh", to: "en" },
      });
    } finally {
      process.env.PROMPT_TRANSLATE_MODE = oldEnv.mode;
      process.env.ARGOS_TRANSLATE_PYTHON = oldEnv.python;
    }
  });
});
