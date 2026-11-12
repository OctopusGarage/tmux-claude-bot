import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveAgentIdentity } from "../../src/core/agents/agent-config-resolver.js";
import { setAgentKind } from "../../src/core/agents/agentKindMap.js";
import { AgentRunnerDispatcher } from "../../src/core/agents/runner-dispatcher.js";
import { executeMessage } from "../../src/core/command/dispatch.js";
import type { QueuedMessage } from "../../src/core/command/queue.js";
import { writeLoopSupervisorWorkerLeaseState } from "../../src/core/loop/supervisor-pool.js";
import { writeLoopSupervisorWorkOrderState } from "../../src/core/loop/supervisor-state.js";
import type { LoopWorkOrder } from "../../src/core/loop/work-order.js";
import { setPathForSession } from "../../src/core/projects/sessionPathMap.js";
import { type ExecFileOptions, TmuxBridge } from "../../src/core/session/tmux.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

afterEach(() => vi.useRealTimers());

function fixture(target: "supervisor" | "worker" | "ordinary" = "supervisor") {
  const dir = mkdtempSync(join(tmpdir(), "tcb-managed-reset-"));
  const supervisor = "tmux_proj_loop-supervisor-1";
  const worker = "tmux_proj_loop-worker-reset-run";
  const session = target === "supervisor" ? supervisor : target === "worker" ? worker : "proj-1";
  const rollout = join(dir, "rollout-current.jsonl");
  const prompt = "Review the accepted implementation";
  let pid: number | null = 123;
  let transcript: LiveAgentIdentity["transcript"] = {
    path: join(dir, "rollout-old.jsonl"),
    sessionId: "old",
    agentPid: 123,
  };
  const workOrder = {
    id: "reset-run",
    scheduledAt: 1,
    projectId: "api",
    projectName: "api",
    projectPath: dir,
    workerSession: worker,
    task: { kind: "architecture" },
    agent: "codex",
    goal: "test",
    maxRounds: 1,
    targetScore: 95,
    runner: { kind: "agent-supervised" },
    allowedActions: [],
    blockedActions: [],
    skills: { approved: [] },
    preflight: { commands: [] },
    verification: { commands: [] },
    pullRequest: { enabled: false },
    requiredFinalMarker: "[LOOP_SUPERVISOR_DONE:reset-run]",
  } as unknown as LoopWorkOrder;
  if (target !== "ordinary") {
    setPathForSession(worker, dir);
    writeLoopSupervisorWorkOrderState({
      workOrder,
      supervisorSession: supervisor,
      status: "in-flight",
      now: Date.now(),
    });
    writeLoopSupervisorWorkerLeaseState({
      leases: [
        {
          workerSession: supervisor,
          workOrderId: workOrder.id,
          projectId: workOrder.projectId,
          projectPath: dir,
          status: "active",
          leasedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });
  }
  setAgentKind(session, "codex");
  const identity = vi.fn(
    async (): Promise<LiveAgentIdentity> => ({
      kind: pid === null ? null : "codex",
      agentPid: pid,
      transcript,
    }),
  );
  const d = fakeDeps({
    config: { maxWaitReadyMs: 1000, maxWaitDoneMs: 100, maxWaitDoneTotalMs: 1000 },
    bridge: {
      hasSession: vi.fn(async () => true),
      resolveSessionName: vi.fn(async () => session),
      capturePane: vi.fn(async () => "› \nContext 100% left"),
      sendKeys: vi.fn(async (text) => {
        if (text === "/clear") {
          transcript = null;
          return;
        }
        if (pid === null) throw new Error("Cannot submit without a native process");
        const record = (type: string, payload: object) => ({
          timestamp: new Date().toISOString(),
          type,
          payload,
        });
        writeFileSync(
          rollout,
          `${[
            record("session_meta", { id: "current", cwd: dir }),
            record("event_msg", { type: "task_started", turn_id: "turn", root_turn_id: "turn" }),
            record("response_item", {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text }],
            }),
            record("response_item", {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "REVIEW COMPLETE" }],
            }),
            record("event_msg", { type: "task_complete", turn_id: "turn", root_turn_id: "turn" }),
          ]
            .map((entry) => JSON.stringify(entry))
            .join("\n")}\n`,
        );
        transcript = { path: rollout, sessionId: "current", agentPid: pid };
      }),
    },
    configResolver: {
      detectAgentKind: vi.fn(async () => (pid === null ? null : "codex")),
      resolveLiveAgentIdentity: identity,
      resolveLiveTranscript: vi.fn(async () => transcript),
    },
    agent: {
      isFreshStartCommand: () => true,
      checkIfRunning: vi.fn(async () => pid !== null),
      exit: vi.fn(async () => {
        pid = null;
        transcript = null;
      }),
      start: vi.fn(async () => {
        pid = 456;
        transcript = null;
      }),
    },
  });
  const nativeWrites: string[] = [];
  let bufferedText = "";
  const native = {
    afterInterrupt: () => {},
    exit: vi.fn(async () => {
      pid = null;
      transcript = null;
    }),
    beforeCommand: async (_args: string[], _options?: ExecFileOptions) => {},
    replaceProcess: () => {
      pid = 999;
      transcript = null;
    },
  };
  const bridgeExec = vi.fn(async (_file: string, args: string[], options?: ExecFileOptions) => {
    await native.beforeCommand(args, options);
    if (args[0] === "display-message") return { stdout: "%7 99", stderr: "" };
    const command = args[0] === "if-shell" ? (args[3] ?? "") : args.join(" ");
    if (command.includes("paste-buffer")) nativeWrites.push(bufferedText);
    if (command.includes("send-keys") && command.includes("C-c")) {
      nativeWrites.push("C-c");
      native.afterInterrupt();
    }
    if (command.includes("/exit")) nativeWrites.push("/exit");
    if (command.includes("send-keys") && /C-m|Enter/.test(command)) await native.exit();
    return { stdout: "", stderr: "" };
  });
  const nativeBridge = new TmuxBridge({
    getSessionName: async () => session,
    execFile: bridgeExec,
    writeFile: async (_path, text) => {
      bufferedText = text;
    },
    unlinkFile: async () => {},
  });
  const codex = d.agent;
  codex.exit = vi.fn(async () => nativeBridge.sendExit(session));
  Object.assign(d.bridge, {
    sendOwnedExit: nativeBridge.sendOwnedExit?.bind(nativeBridge),
  });
  d.agent = new AgentRunnerDispatcher({
    bridge: d.bridge,
    claude: fakeDeps().agent,
    codex,
    configResolver: d.configResolver,
    maxWaitReadyMs: d.config.maxWaitReadyMs,
  });
  const message = (action: "clear" | "compact" | "text", origin: "system" | "user" = "system") =>
    ({
      id: action,
      action,
      text: action === "text" ? prompt : "",
      chatId: "loop-engineering",
      channel: "control",
      sessionName: session,
      origin,
      ...(action === "text" ? { doneProbe: () => true } : {}),
      resolve: () => {},
      reject: () => {},
    }) as QueuedMessage;
  return { d, codex, session, identity, message, native, nativeWrites, bridgeExec };
}

async function settle<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("owned Codex context reset", () => {
  it.each(["supervisor", "worker"] as const)(
    "binds a lazy rollout after clearing a reused %s through a fresh native start",
    async (target) => {
      const f = fixture(target);
      const result = await settle(
        executeMessage(f.message("clear"), f.d).then(() => executeMessage(f.message("text"), f.d)),
      );
      expect(result).toEqual({ value: "REVIEW COMPLETE" });
      expect(f.nativeWrites).toEqual(["C-c", "/exit"]);
      expect(f.codex.start).toHaveBeenCalledOnce();
      expect(f.d.bridge.sendKeys).toHaveBeenCalledExactlyOnceWith(
        "Review the accepted implementation",
        f.session,
      );
      expect(f.d.agent.consumeFreshLaunch?.(f.session, 456)).toBeNull();
    },
  );

  it("preserves ordinary user clear semantics", async () => {
    const f = fixture("ordinary");
    expect(await settle(executeMessage(f.message("clear", "user"), f.d))).toHaveProperty("value");
    expect(f.d.bridge.sendKeys).toHaveBeenCalledExactlyOnceWith("/clear", f.session);
    expect(f.codex.exit).not.toHaveBeenCalled();
    expect(f.codex.start).not.toHaveBeenCalled();
  });

  it("rejects a pending composer before stopping an owned process", async () => {
    const f = fixture();
    vi.mocked(f.d.bridge.capturePane).mockResolvedValue("› another pending task");
    await expect(executeMessage(f.message("clear"), f.d)).rejects.toThrow(/input surface/);
    expect(f.codex.exit).not.toHaveBeenCalled();
    expect(f.codex.start).not.toHaveBeenCalled();
  });

  it("never starts again if the previous native process remains alive", async () => {
    const f = fixture();
    f.native.exit.mockResolvedValue(undefined);
    const result = await settle(executeMessage(f.message("clear"), f.d));
    expect(result).toHaveProperty(
      "error",
      expect.objectContaining({ message: expect.stringMatching(/deadline|stop/i) }),
    );
    expect(f.codex.start).not.toHaveBeenCalled();
    expect(f.d.agent.consumeFreshLaunch?.(f.session, 123)).toBeNull();
  });

  it("does not relaunch after ownership expires during exit", async () => {
    const f = fixture();
    f.native.exit.mockImplementation(async () => {
      writeLoopSupervisorWorkerLeaseState({ leases: [] });
    });
    const result = await settle(executeMessage(f.message("clear"), f.d));
    expect(result).toHaveProperty(
      "error",
      expect.objectContaining({ message: expect.stringMatching(/ownership/i) }),
    );
    expect(f.codex.start).not.toHaveBeenCalled();
  });

  it("blocks unavailable identity before stopping the process", async () => {
    const f = fixture();
    f.d.configResolver.resolveLiveAgentIdentity = vi.fn(async () => null);
    await expect(executeMessage(f.message("clear"), f.d)).rejects.toThrow(/identity/);
    expect(f.codex.exit).not.toHaveBeenCalled();
    expect(f.codex.start).not.toHaveBeenCalled();
  });

  it("blocks a replacement process during exit without granting it bootstrap", async () => {
    const f = fixture();
    f.identity
      .mockResolvedValueOnce({ kind: "codex", agentPid: 123, transcript: null })
      .mockResolvedValueOnce({ kind: "codex", agentPid: 999, transcript: null });
    await expect(executeMessage(f.message("clear"), f.d)).rejects.toThrow(/process changed/);
    expect(f.codex.start).not.toHaveBeenCalled();
    expect(f.d.agent.consumeFreshLaunch?.(f.session, 999)).toBeNull();
  });

  it("bounds an unavailable initial identity probe by the readiness deadline", async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.identity.mockImplementation(() => new Promise(() => {}));
    const result = settle(executeMessage(f.message("clear"), f.d));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toHaveProperty(
      "error",
      expect.objectContaining({ message: expect.stringMatching(/deadline/) }),
    );
    expect(f.codex.exit).not.toHaveBeenCalled();
    expect(f.codex.start).not.toHaveBeenCalled();
  });

  it("passes the original readiness deadline to startup after a delayed exit", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const deadline = Date.now() + f.d.config.maxWaitReadyMs;
    const exit = f.native.exit.getMockImplementation();
    if (!exit) throw new Error("Expected exit fixture");
    f.native.exit.mockImplementation(async () => {
      await exit();
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const result = settle(executeMessage(f.message("clear"), f.d));
    await vi.advanceTimersByTimeAsync(900);
    expect(await result).toHaveProperty("value");
    expect(f.codex.start).toHaveBeenCalledExactlyOnceWith(f.session, undefined, deadline);
  });

  it.each(["ownership", "process"] as const)(
    "does not submit /exit after %s changes between interrupt and exit",
    async (change) => {
      const f = fixture();
      f.native.afterInterrupt = () => {
        if (change === "ownership") writeLoopSupervisorWorkerLeaseState({ leases: [] });
        else f.native.replaceProcess();
      };
      await expect(executeMessage(f.message("clear"), f.d)).rejects.toThrow(
        /ownership|process changed/,
      );
      expect(f.nativeWrites).toEqual(["C-c"]);
      expect(f.codex.start).not.toHaveBeenCalled();
      expect(f.d.agent.consumeFreshLaunch?.(f.session, 999)).toBeNull();
    },
  );

  it("cancels a stalled stop command within the readiness deadline without later writes", async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.native.beforeCommand = async (args, options) => {
      if (!args.join(" ").includes("C-c")) return;
      await new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("tmux command timed out")), options?.timeout ?? 10000);
      });
    };
    let completed = false;
    const result = settle(executeMessage(f.message("clear"), f.d)).then((value) => {
      completed = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    const completedAtDeadline = completed;
    await vi.advanceTimersByTimeAsync(10000);
    expect(await result).toHaveProperty("error");
    expect(completedAtDeadline).toBe(true);
    expect(f.nativeWrites).toEqual([]);
    expect(f.codex.start).not.toHaveBeenCalled();
    expect(f.d.agent.consumeFreshLaunch?.(f.session, 123)).toBeNull();
  });

  it("skips /exit when Ctrl-C already stopped the exact owned process", async () => {
    const f = fixture();
    f.native.afterInterrupt = () => {
      void f.native.exit();
    };
    await executeMessage(f.message("clear"), f.d);
    expect(f.nativeWrites).toEqual(["C-c"]);
    expect(f.codex.exit).not.toHaveBeenCalled();
    expect(f.codex.start).toHaveBeenCalledOnce();
    expect(f.d.agent.consumeFreshLaunch?.(f.session, 456)).toMatchObject({ agentPid: 456 });
  });

  it("does not resume exit after a timed-out identity guard eventually resolves", async () => {
    const f = fixture();
    vi.useFakeTimers();
    let release: ((identity: LiveAgentIdentity) => void) | undefined;
    f.native.afterInterrupt = () => {
      f.identity.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    };
    const result = settle(executeMessage(f.message("clear"), f.d));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toHaveProperty(
      "error",
      expect.objectContaining({ message: expect.stringMatching(/deadline/) }),
    );
    expect(release).toBeDefined();
    release?.({ kind: "codex", agentPid: 123, transcript: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.nativeWrites).toEqual(["C-c"]);
    expect(f.codex.start).not.toHaveBeenCalled();
    expect(f.d.agent.consumeFreshLaunch?.(f.session, 123)).toBeNull();
  });

  it("discards the fresh grant if ownership expires while starting", async () => {
    const f = fixture();
    const start = vi.mocked(f.codex.start).getMockImplementation();
    if (!start) throw new Error("Expected start fixture");
    vi.mocked(f.codex.start).mockImplementation(async (...args) => {
      await start(...args);
      writeLoopSupervisorWorkerLeaseState({ leases: [] });
    });
    await expect(executeMessage(f.message("clear"), f.d)).rejects.toThrow(/ownership/);
    expect(f.d.agent.consumeFreshLaunch?.(f.session, 456)).toBeNull();
  });
});
