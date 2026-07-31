import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedMessage } from "../../src/core/command/queue.js";
import { MessageQueue } from "../../src/core/command/queue.js";
import {
  createLoopQueueAgentTaskRunner,
  createLoopSupervisorTaskRunner,
  restoreLoopControlQueue,
} from "../../src/core/loop/agent-queue.js";
import { LoopBacklogStore } from "../../src/core/loop/backlog.js";
import { listLoopReports } from "../../src/core/loop/report.js";
import {
  readLoopSupervisorWorkerLeaseState,
  writeLoopSupervisorWorkerLeaseState,
} from "../../src/core/loop/supervisor-pool.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { sessionNameFromPath } from "../../src/core/projects/sessionPathMap.js";

let originalStateDir: string | undefined;

beforeEach(() => {
  originalStateDir = process.env.TCB_STATE_DIR;
  process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-loop-state-"));
});

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.TCB_STATE_DIR;
  } else {
    process.env.TCB_STATE_DIR = originalStateDir;
  }
});

function queueDeps(projectPath: string, live: boolean, liveAgent?: "claude" | "codex" | null) {
  const prefix = "tmux_proj_";
  const liveSession = sessionNameFromPath(projectPath, prefix);
  const liveSessions = new Set(live ? [liveSession] : []);
  const queue = new MessageQueue(
    30,
    join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
  );
  return {
    queue,
    deps: {
      queue,
      config: { projectSessionPrefix: prefix },
      bridge: {
        hasSession: async (sessionName: string) => liveSessions.has(sessionName),
      },
      ...(liveAgent !== undefined
        ? {
            configResolver: {
              detectAgentKind: async (sessionName: string) =>
                liveSessions.has(sessionName) ? liveAgent : null,
            },
          }
        : {}),
    },
  };
}

describe("createLoopQueueAgentTaskRunner", () => {
  it("queues a loop task into the live project session and resolves with handler output", async () => {
    const projectPath = "/repo/hub";
    const { queue, deps } = queueDeps(projectPath, true);
    const handled: string[] = [];
    queue.setHandler(async (message) => {
      handled.push(`${message.sessionName}:${message.text}`);
      message.resolve("agent done");
    });

    const result = await createLoopQueueAgentTaskRunner(deps)({
      projectId: "hub",
      projectName: "Hub",
      agent: "codex",
      cwd: projectPath,
      prompt: "Fix one safe finding",
      finding: {
        id: "f1",
        title: "Focused test gap",
        action: "tests",
        confidence: "high",
        autofixSafety: "safe",
        affectedFiles: ["tests/parser.test.ts"],
        prompt: "Add focused tests",
        verificationCommands: ["npm test -- tests/parser.test.ts"],
      },
    });

    expect(result).toEqual({ status: 0, stdout: "agent done", stderr: "" });
    expect(handled).toEqual([
      `${sessionNameFromPath(projectPath, "tmux_proj_")}:Fix one safe finding`,
    ]);
  });

  it("queues compact before a loop task when a round reset is requested", async () => {
    const projectPath = "/repo/hub";
    const { queue, deps } = queueDeps(projectPath, true);
    const handled: Array<{ action: string; text: string }> = [];
    queue.setHandler(async (message) => {
      handled.push({ action: message.action, text: message.text });
      message.resolve(message.action === "compact" ? "compacted" : "agent done");
    });

    const result = await createLoopQueueAgentTaskRunner(deps)({
      projectId: "hub",
      projectName: "Hub",
      agent: "codex",
      cwd: projectPath,
      prompt: "Fix one safe finding",
      contextReset: "compact",
      finding: {
        id: "f1",
        title: "Focused test gap",
        action: "tests",
        confidence: "high",
        autofixSafety: "safe",
        affectedFiles: ["tests/parser.test.ts"],
        prompt: "Add focused tests",
        verificationCommands: ["npm test -- tests/parser.test.ts"],
      },
    });

    expect(result).toEqual({ status: 0, stdout: "agent done", stderr: "" });
    expect(handled).toEqual([
      { action: "compact", text: "" },
      { action: "text", text: "Fix one safe finding" },
    ]);
  });

  it("persists queued loop tasks so scheduled work survives a restart", async () => {
    const projectPath = "/repo/hub";
    const { queue, deps } = queueDeps(projectPath, true);
    queue.setReadinessProbe(async () => false, 60_000);
    queue.setHandler(async (message) => {
      message.resolve("should not run while busy");
    });

    void createLoopQueueAgentTaskRunner(deps)({
      projectId: "hub",
      projectName: "Hub",
      agent: "codex",
      cwd: projectPath,
      prompt: "Fix one safe finding",
      finding: {
        id: "f1",
        title: "Focused test gap",
        action: "tests",
        confidence: "high",
        autofixSafety: "safe",
        affectedFiles: ["tests/parser.test.ts"],
        prompt: "Add focused tests",
        verificationCommands: ["npm test -- tests/parser.test.ts"],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    queue.flushPending();

    expect(queue.loadPersisted()).toEqual([
      expect.objectContaining({
        text: "Fix one safe finding",
        chatId: "loop-engineering",
        channel: "control",
        sessionName: sessionNameFromPath(projectPath, "tmux_proj_"),
        action: "text",
        origin: "system",
        promptSource: "control",
      }),
    ]);
  });

  it("fails without queueing when the project session is not live", async () => {
    const projectPath = "/repo/hub";
    const { queue, deps } = queueDeps(projectPath, false);

    const result = await createLoopQueueAgentTaskRunner(deps)({
      projectId: "hub",
      projectName: "Hub",
      agent: "codex",
      cwd: projectPath,
      prompt: "Fix one safe finding",
      finding: {
        id: "f1",
        title: "Focused test gap",
        action: "tests",
        confidence: "high",
        autofixSafety: "safe",
        affectedFiles: ["tests/parser.test.ts"],
        prompt: "Add focused tests",
        verificationCommands: ["npm test -- tests/parser.test.ts"],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no live project session for loop project "hub"');
    expect(queue.isEmpty()).toBe(true);
  });

  it("starts a missing project session before queueing scheduled loop work", async () => {
    const projectPath = "/repo/hub";
    const prefix = "tmux_proj_";
    const liveSession = sessionNameFromPath(projectPath, prefix);
    const liveSessions = new Set<string>();
    let liveAgent: "claude" | "codex" | null = null;
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const created: string[] = [];
    const started: string[] = [];
    queue.setHandler(async (message) => {
      message.resolve(`handled ${message.sessionName}`);
    });

    const result = await createLoopQueueAgentTaskRunner({
      queue,
      config: { projectSessionPrefix: prefix },
      bridge: {
        hasSession: async (sessionName: string) => liveSessions.has(sessionName),
        createSession: async (sessionName: string, cwd?: string) => {
          created.push(`${sessionName}:${cwd ?? ""}`);
          liveSessions.add(sessionName);
          return true;
        },
      },
      agent: {
        start: async (sessionName?: string) => {
          if (sessionName !== undefined) {
            started.push(sessionName);
            liveAgent = "codex";
          }
        },
      },
      configResolver: {
        detectAgentKind: async (sessionName: string) =>
          liveSessions.has(sessionName) ? liveAgent : null,
      },
    })({
      projectId: "hub",
      projectName: "Hub",
      agent: "codex",
      cwd: projectPath,
      prompt: "Fix one safe finding",
      finding: {
        id: "f1",
        title: "Focused test gap",
        action: "tests",
        confidence: "high",
        autofixSafety: "safe",
        affectedFiles: ["tests/parser.test.ts"],
        prompt: "Add focused tests",
        verificationCommands: ["npm test -- tests/parser.test.ts"],
      },
    });

    expect(result).toEqual({ status: 0, stdout: `handled ${liveSession}`, stderr: "" });
    expect(created).toEqual([`${liveSession}:${projectPath}`]);
    expect(started).toEqual([liveSession]);
  });

  it("fails without queueing when the live project session uses the wrong agent", async () => {
    const projectPath = "/repo/hub";
    const { queue, deps } = queueDeps(projectPath, true, "claude");

    const result = await createLoopQueueAgentTaskRunner(deps)({
      projectId: "hub",
      projectName: "Hub",
      agent: "codex",
      cwd: projectPath,
      prompt: "Fix one safe finding",
      finding: {
        id: "f1",
        title: "Focused test gap",
        action: "tests",
        confidence: "high",
        autofixSafety: "safe",
        affectedFiles: ["tests/parser.test.ts"],
        prompt: "Add focused tests",
        verificationCommands: ["npm test -- tests/parser.test.ts"],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('loop project "hub" requires codex but live session is claude');
    expect(queue.isEmpty()).toBe(true);
  });
});

describe("createLoopSupervisorTaskRunner", () => {
  const workOrder = {
    id: "wo-1",
    scheduledAt: 1_000,
    projectId: "hub",
    projectName: "Hub",
    projectPath: "/repo/hub",
    agent: "codex",
    goal: "Improve architecture.",
    maxRounds: 3,
    targetScore: 90,
    runner: { kind: "agent-supervised", timeoutMs: 1000, requireConfirmation: false },
    allowedActions: ["tests"],
    blockedActions: ["direct-model-api"],
    skills: { approved: [] },
    preflight: { commands: [], repair: { agent: false } },
    assessment: { command: "npm run assess" },
    execution: { agent: true },
    recovery: { agent: false, dirtyWorktree: false, maxAttempts: 1 },
    commitPolicy: { enabled: false, perRound: true },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:wo-1]",
  } satisfies LoopWorkOrder;

  function persistedSupervisorMessage(id: string, text: string): PersistedMessage {
    return {
      id,
      text,
      chatId: "loop-engineering",
      channel: "control",
      sessionName: "tmux_proj_loop-supervisor",
      action: "text",
      origin: "system",
      promptSource: "control",
      controlRestore: {
        kind: "loop-supervisor",
        supervisorSession: "tmux_proj_loop-supervisor",
        queuedAt: 1_000,
        workOrder: { ...workOrder, id },
      },
    };
  }

  it("queues a loop supervisor task directly into the reserved supervisor session", async () => {
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
      },
    };
    const handled: string[] = [];
    const waitHorizons: Array<number | undefined> = [];
    queue.setHandler(async (message) => {
      handled.push(`${message.sessionName}:${message.text}`);
      waitHorizons.push(message.maxWaitDoneTotalMs);
      message.resolve("supervisor done");
    });

    const result = await createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: new AbortController().signal,
      workOrder,
      timeoutMs: 7_200_000,
    });

    expect(result).toEqual({ status: 0, stdout: "supervisor done", stderr: "" });
    expect(handled).toEqual(["tmux_proj_loop-supervisor:Run supervised work order"]);
    expect(waitHorizons).toEqual([7_200_000]);
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([
      expect.objectContaining({
        workerSession: "tmux_proj_loop-supervisor",
        workOrderId: "wo-1",
        status: "active",
      }),
    ]);
  });

  it("blocks supervisor work when the worker is already leased", async () => {
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: "tmux_proj_loop-supervisor",
          workOrderId: "wo-active",
          projectId: "active",
          projectPath: "/repo/active",
          status: "active",
          leasedAt: 1_000,
          updatedAt: 1_000,
        },
      ],
    });
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
      },
    };

    const result = await createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: new AbortController().signal,
      workOrder,
    });

    expect(result).toEqual({
      status: 1,
      stdout: "",
      stderr: "worker tmux_proj_loop-supervisor is leased by wo-active",
    });
    expect(queue.isEmpty()).toBe(true);
  });

  it("retains a supervisor worker lease when queued work fails", async () => {
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
      },
    };
    queue.setHandler(async (message) => {
      message.reject(new Error("supervisor failed"));
    });

    const result = await createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: new AbortController().signal,
      workOrder,
    });

    expect(result).toEqual({ status: 1, stdout: "", stderr: "supervisor failed" });
    expect(readLoopSupervisorWorkerLeaseState().leases).toEqual([
      expect.objectContaining({
        workerSession: "tmux_proj_loop-supervisor",
        workOrderId: "wo-1",
        status: "retained",
        retainUntil: expect.any(Number),
      }),
    ]);
  });

  it("queues clear before a loop supervisor work order when requested", async () => {
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor-1",
      },
    };
    const handled: Array<{ action: string; text: string }> = [];
    queue.setHandler(async (message) => {
      handled.push({ action: message.action, text: message.text });
      message.resolve(message.action === "clear" ? "cleared" : "supervisor done");
    });

    const result = await createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor-1",
      prompt: "Run supervised work order",
      signal: new AbortController().signal,
      workOrder,
      contextReset: "clear",
    });

    expect(result).toEqual({ status: 0, stdout: "supervisor done", stderr: "" });
    expect(handled).toEqual([
      { action: "clear", text: "" },
      { action: "text", text: "Run supervised work order" },
    ]);
  });

  it("persists queued loop supervisor work so scheduled work survives a restart", async () => {
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
      },
    };
    queue.setReadinessProbe(async () => false, 60_000);
    queue.setHandler(async (message) => {
      message.resolve("should not run while busy");
    });

    void createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: new AbortController().signal,
      workOrder,
    });
    await new Promise((resolve) => setImmediate(resolve));
    queue.flushPending();

    expect(queue.loadPersisted()).toEqual([
      expect.objectContaining({
        text: "Run supervised work order",
        chatId: "loop-engineering",
        channel: "control",
        sessionName: "tmux_proj_loop-supervisor",
        action: "text",
        origin: "system",
        promptSource: "control",
        controlRestore: expect.objectContaining({
          kind: "loop-supervisor",
          supervisorSession: "tmux_proj_loop-supervisor",
          workOrder: expect.objectContaining({ id: "wo-1", projectId: "hub" }),
        }),
      }),
    ]);
  });

  it("restores persisted supervisor control work through the loop reporting path", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "tcb-loop-control-restore-state-"));
    process.env.TCB_STATE_DIR = stateDir;
    const persistPath = join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json");
    const queue = new MessageQueue(30, persistPath);
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
      },
    };
    queue.setReadinessProbe(async () => false, 60_000);
    queue.setHandler(async (message) => {
      message.resolve("should not run before restart");
    });
    void createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: new AbortController().signal,
      workOrder,
    });
    await new Promise((resolve) => setImmediate(resolve));
    queue.flushPending();

    const restoredQueue = new MessageQueue(30, persistPath);
    restoredQueue.setHandler(async (message) => {
      message.resolve(
        `${workOrder.requiredFinalMarker}\n{"status":"completed","projectId":"hub","actionsTaken":["restored"],"delegatedTasks":[],"finalVerification":"passed","commits":[],"followUps":["Check restored report"]}`,
      );
    });

    const restored = restoreLoopControlQueue({ queue: restoredQueue });
    await new Promise((resolve) => setImmediate(resolve));

    expect(restored).toBe(1);
    expect(restoredQueue.loadPersisted()).toEqual([]);
    expect(listLoopReports()).toEqual([
      expect.objectContaining({
        runId: "wo-1",
        projectId: "hub",
        status: "passed",
      }),
    ]);
    expect(new LoopBacklogStore().list()).toEqual([
      expect.objectContaining({
        projectId: "hub",
        text: "Check restored report",
      }),
    ]);
  });

  it("keeps supervisor control work persisted when restore cannot re-enqueue it", async () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json");
    writeFileSync(
      persistPath,
      `${JSON.stringify(
        [
          persistedSupervisorMessage("wo-queued", "Run queued work order"),
          persistedSupervisorMessage("wo-blocked", "Run blocked work order"),
        ],
        null,
        2,
      )}\n`,
    );
    const restoredQueue = new MessageQueue(1, persistPath);
    restoredQueue.setReadinessProbe(async () => false, 60_000);
    restoredQueue.setHandler(async (message) => {
      message.resolve("should not run while busy");
    });

    const restored = restoreLoopControlQueue({ queue: restoredQueue });
    restoredQueue.flushPending();

    expect(restored).toBe(1);
    expect(
      restoredQueue
        .loadPersisted()
        .map((message) => message.id)
        .sort(),
    ).toEqual(["wo-blocked", "wo-queued"]);
  });

  it("keeps duplicate supervisor control work persisted when restore dedupes it", async () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json");
    writeFileSync(
      persistPath,
      `${JSON.stringify(
        [
          persistedSupervisorMessage("wo-first", "Run same work order"),
          persistedSupervisorMessage("wo-duplicate", "Run same work order"),
        ],
        null,
        2,
      )}\n`,
    );
    const restoredQueue = new MessageQueue(30, persistPath);
    restoredQueue.setReadinessProbe(async () => false, 60_000);
    restoredQueue.setHandler(async (message) => {
      message.resolve("should not run while busy");
    });

    const restored = restoreLoopControlQueue({ queue: restoredQueue });
    restoredQueue.flushPending();

    expect(restored).toBe(1);
    expect(
      restoredQueue
        .loadPersisted()
        .map((message) => message.id)
        .sort(),
    ).toEqual(["wo-duplicate", "wo-first"]);
  });

  it("cancels a queued supervisor task when the abort signal fires before handling", async () => {
    vi.useFakeTimers();
    try {
      const queue = new MessageQueue(
        30,
        join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
      );
      const deps = {
        queue,
        config: { projectSessionPrefix: "tmux_proj_" },
        bridge: {
          hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
        },
      };
      queue.setReadinessProbe(async () => false, 60_000);
      queue.setHandler(async (message) => {
        message.resolve("should not run");
      });
      const controller = new AbortController();

      const pending = createLoopSupervisorTaskRunner(deps)({
        session: "tmux_proj_loop-supervisor",
        prompt: "Run supervised work order",
        signal: controller.signal,
        workOrder,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(queue.size("tmux_proj_loop-supervisor")).toBe(1);
      controller.abort();

      await expect(pending).resolves.toEqual({
        status: 1,
        stdout: "",
        stderr: "loop supervisor task was cancelled",
      });
      expect(queue.size("tmux_proj_loop-supervisor")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not enqueue if the signal aborts while checking the supervisor session", async () => {
    let resolveHasSession: ((live: boolean) => void) | undefined;
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async () =>
          new Promise<boolean>((resolve) => {
            resolveHasSession = resolve;
          }),
      },
    };
    const controller = new AbortController();

    const pending = createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: controller.signal,
      workOrder,
    });

    controller.abort();
    resolveHasSession?.(true);

    await expect(pending).resolves.toEqual({
      status: 1,
      stdout: "",
      stderr: "loop supervisor task was cancelled before enqueue",
    });
    expect(queue.size("tmux_proj_loop-supervisor")).toBe(0);
  });

  it("does not claim an in-flight supervisor task was cancelled by abort", async () => {
    const queue = new MessageQueue(
      30,
      join(mkdtempSync(join(tmpdir(), "tcb-loop-queue-")), "pending.json"),
    );
    const deps = {
      queue,
      config: { projectSessionPrefix: "tmux_proj_" },
      bridge: {
        hasSession: async (sessionName: string) => sessionName === "tmux_proj_loop-supervisor",
      },
    };
    let resolveMessage: ((output: string) => void) | undefined;
    queue.setHandler(async (message) => {
      resolveMessage = message.resolve;
    });
    const controller = new AbortController();
    let settled = false;

    const pending = createLoopSupervisorTaskRunner(deps)({
      session: "tmux_proj_loop-supervisor",
      prompt: "Run supervised work order",
      signal: controller.signal,
      workOrder,
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    resolveMessage?.("supervisor eventually finished");
    await expect(pending).resolves.toEqual({
      status: 0,
      stdout: "supervisor eventually finished",
      stderr: "",
    });
  });
});
