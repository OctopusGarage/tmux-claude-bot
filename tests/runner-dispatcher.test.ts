import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver } from "../src/core/agents/agent-config-resolver.js";
import { setAgentKind } from "../src/core/agents/agentKindMap.js";
import { CodexRunner } from "../src/core/agents/codex/codex-runner.js";
import { getLastLiveSessionId } from "../src/core/agents/live-session-id.js";
import type { AgentRunner } from "../src/core/agents/runner.js";
import { AgentRunnerDispatcher } from "../src/core/agents/runner-dispatcher.js";
import type { AgentKind } from "../src/core/agents/types.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-dispatcher-"));
  process.env.TCB_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.TCB_STATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeRunner(name: string): AgentRunner & { calls: string[] } {
  const calls: string[] = [];
  const record =
    (method: string) =>
    async (..._args: unknown[]) => {
      calls.push(method);
      return { done: true, output: `${name}:${method}` } as never;
    };
  return {
    calls,
    checkIfRunning: record("checkIfRunning"),
    start: record("start"),
    startWithResume: record("startWithResume"),
    waitUntilReady: record("waitUntilReady"),
    waitUntilInputReady: record("waitUntilInputReady"),
    waitUntilDone: record("waitUntilDone"),
    interrupt: record("interrupt"),
    exit: record("exit"),
    gracefulRestart: record("gracefulRestart"),
    gracefulRestartWithContinue: record("gracefulRestartWithContinue"),
  };
}

function fakeBridge(session = "tmux_proj_x") {
  return {
    resolveSessionName: vi.fn(async (_s?: string) => session),
  };
}

/** ConfigResolver whose detectAgentKind returns a controllable value (null =
 * "no live process detected" → routing falls back to the persisted kind). */
function fakeConfigResolver(detected: AgentKind | null = null): ConfigResolver {
  return {
    resolveConfigRoot: async () => "/cfg",
    isClaudeRunning: async () => false,
    isCodexRunning: async () => false,
    detectAgentKind: async () => detected,
    invalidate: () => {},
  };
}

describe("AgentRunnerDispatcher", () => {
  it("routes to claude by default (no agent kind set)", async () => {
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_x") as never,
      claude,
      codex,
      configResolver: fakeConfigResolver(),
    });

    await dispatcher.start("tmux_proj_x");
    expect(claude.calls).toContain("start");
    expect(codex.calls).toHaveLength(0);
  });

  it("forwards the command override through startWithResume to the picked runner", async () => {
    const claude = fakeRunner("claude");
    const startWithResume = vi.fn(async () => {});
    claude.startWithResume = startWithResume as never;
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_z") as never,
      claude,
      codex: fakeRunner("codex"),
      configResolver: fakeConfigResolver(),
    });

    await dispatcher.startWithResume(
      "tmux_proj_z",
      "uuid-9",
      "CLAUDE_CONFIG_DIR=~/.claude-stella claude",
    );

    expect(startWithResume).toHaveBeenCalledWith(
      "tmux_proj_z",
      "uuid-9",
      "CLAUDE_CONFIG_DIR=~/.claude-stella claude",
    );
  });

  it("persists the resumed conversation id as the live id (reboot recovery resumes THIS one)", async () => {
    const claude = fakeRunner("claude");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_resume") as never,
      claude,
      codex: fakeRunner("codex"),
      configResolver: fakeConfigResolver(),
    });

    await dispatcher.startWithResume("tmux_proj_resume", "uuid-resumed");

    // Without this, the recorded id would still point at the pre-resume
    // conversation, so a reboot would resume the wrong one (recover.ts reads it).
    expect(getLastLiveSessionId("tmux_proj_resume")).toBe("uuid-resumed");
  });

  it("routes to codex when the session has agent kind 'codex'", async () => {
    setAgentKind("tmux_proj_y", "codex");
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_y") as never,
      claude,
      codex,
      configResolver: fakeConfigResolver(),
    });

    await dispatcher.start("tmux_proj_y");
    expect(codex.calls).toContain("start");
    expect(claude.calls).toHaveLength(0);
  });

  it("routes checkIfRunning to codex for a codex session", async () => {
    setAgentKind("tmux_proj_z", "codex");
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_z") as never,
      claude,
      codex,
      configResolver: fakeConfigResolver(),
    });

    await dispatcher.checkIfRunning("tmux_proj_z");
    expect(codex.calls).toContain("checkIfRunning");
    expect(claude.calls).toHaveLength(0);
  });

  it("routes waitUntilDone to claude for a default (claude) session", async () => {
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_default") as never,
      claude,
      codex,
      configResolver: fakeConfigResolver(),
    });

    const result = await dispatcher.waitUntilDone("tmux_proj_default");
    expect(claude.calls).toContain("waitUntilDone");
    expect(codex.calls).toHaveLength(0);
    expect(result).toEqual({ done: true, output: "claude:waitUntilDone" });
  });

  it("passes the original args through to the delegate", async () => {
    const claude = fakeRunner("claude");
    const startSpy = vi.fn(async () => {});
    claude.start = startSpy;
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_a") as never,
      claude,
      codex: fakeRunner("codex"),
      configResolver: fakeConfigResolver(),
    });

    await dispatcher.start("tmux_proj_a", "my-custom-command");
    expect(startSpy).toHaveBeenCalledWith("tmux_proj_a", "my-custom-command");
  });

  it("detection wins: routes to codex when the live process is codex even if persisted kind is claude", async () => {
    setAgentKind("tmux_proj_live", "claude"); // stale record says claude
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_live") as never,
      claude,
      codex,
      configResolver: fakeConfigResolver("codex"), // live process detected: codex
    });

    await dispatcher.checkIfRunning("tmux_proj_live");
    expect(codex.calls).toContain("checkIfRunning");
    expect(claude.calls).toHaveLength(0);
  });

  it("falls back to the persisted kind when no live process is detected", async () => {
    setAgentKind("tmux_proj_gap", "codex"); // launch-intent set, process not visible yet
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_gap") as never,
      claude,
      codex,
      configResolver: fakeConfigResolver(null), // nothing live → use persisted
    });

    await dispatcher.start("tmux_proj_gap");
    expect(codex.calls).toContain("start");
    expect(claude.calls).toHaveLength(0);
  });

  // Every method on the AgentRunner surface must route to the picked backend —
  // not just the few spot-checked above. A new method that forgets to delegate
  // (or delegates to the wrong agent) is caught here.
  it("routes EVERY method to the detected backend (full surface)", async () => {
    const s = "tmux_proj_full";
    const claude = fakeRunner("claude");
    const codex = fakeRunner("codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge(s) as never,
      claude,
      codex,
      configResolver: fakeConfigResolver("codex"), // live codex
    });

    await dispatcher.checkIfRunning(s);
    await dispatcher.start(s, "cmd");
    await dispatcher.startWithResume(s, "uuid-1");
    await dispatcher.waitUntilReady(s);
    await dispatcher.waitUntilInputReady(s);
    await dispatcher.waitUntilDone(s);
    await dispatcher.interrupt(s);
    await dispatcher.exit(s);
    await dispatcher.gracefulRestart(s);
    await dispatcher.gracefulRestartWithContinue(s, "cmd");

    const expected = [
      "checkIfRunning",
      "start",
      "startWithResume",
      "waitUntilReady",
      "waitUntilInputReady",
      "waitUntilDone",
      "interrupt",
      "exit",
      "gracefulRestart",
      "gracefulRestartWithContinue",
    ];
    expect(codex.calls).toEqual(expected); // all routed to codex, in order
    expect(claude.calls).toHaveLength(0); // nothing leaked to claude
  });
});

describe("fresh managed launch grant", () => {
  it("issues one grant only after a proven absent-to-fresh native Codex start", async () => {
    let live = false;
    const resolver = Object.assign(fakeConfigResolver(), {
      resolveLiveAgentIdentity: async () =>
        live
          ? { kind: "codex" as const, agentPid: 987, transcript: null }
          : { kind: null, agentPid: null, transcript: null },
    });
    const codex = Object.assign(fakeRunner("codex"), { isFreshStartCommand: (): boolean => true });
    codex.start = vi.fn(async () => {
      live = true;
    });
    setAgentKind("tmux_proj_fresh", "codex");
    const dispatcher = new AgentRunnerDispatcher({
      maxWaitReadyMs: 1000,
      bridge: fakeBridge("tmux_proj_fresh") as never,
      claude: fakeRunner("claude"),
      codex,
      configResolver: resolver,
    });
    await dispatcher.start("tmux_proj_fresh");
    const grants = dispatcher as unknown as {
      consumeFreshLaunch(session: string, pid: number): unknown;
    };
    expect(grants.consumeFreshLaunch("tmux_proj_fresh", 987)).toMatchObject({ agentPid: 987 });
    expect(grants.consumeFreshLaunch("tmux_proj_fresh", 987)).toBeNull();
    await dispatcher.start("tmux_proj_fresh");
    expect(grants.consumeFreshLaunch("tmux_proj_fresh", 987)).toBeNull();
  });
});

describe("bounded fresh Codex registration", () => {
  const absent = { kind: null, agentPid: null, transcript: null };
  const live = { kind: "codex" as const, agentPid: 987, transcript: null };
  function fixture(
    identity: NonNullable<ConfigResolver["resolveLiveAgentIdentity"]>,
    start = async () => {},
    budgetMs = 50,
  ) {
    const session = "tmux_proj_registration";
    setAgentKind(session, "codex");
    const codex = Object.assign(fakeRunner("codex"), {
      isFreshStartCommand: (): boolean => true,
      start,
    });
    const dispatcher = new AgentRunnerDispatcher({
      bridge: fakeBridge(session) as never,
      claude: fakeRunner("claude"),
      codex,
      configResolver: Object.assign(fakeConfigResolver(), { resolveLiveAgentIdentity: identity }),
      maxWaitReadyMs: budgetMs,
    });
    return { session, codex, dispatcher };
  }
  it.each(["same", "different", "invalidated"] as const)(
    "serializes overlapping %s start intent without erasing the owner's pending grant",
    async (intent) => {
      vi.useFakeTimers();
      let probes = 0;
      let release!: () => void;
      const launched = new Promise<void>((resolve) => {
        release = resolve;
      });
      let starts = 0;
      const f = fixture(
        async () => (++probes === 1 ? absent : live),
        async () => {
          if (++starts === 1) await launched;
        },
        1000,
      );
      f.codex.isFreshStartCommand = (command?: string) => command === "codex --yolo";
      const first = f.dispatcher.start(f.session, "codex --yolo");
      await vi.advanceTimersByTimeAsync(0);
      const second = f.dispatcher.start(
        f.session,
        intent === "different" ? "unknown-launcher" : "codex --yolo",
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(starts).toBe(1);
        if (intent === "invalidated") f.dispatcher.consumeFreshLaunch(f.session, -1);
      } finally {
        release();
        await first;
        await second;
      }
      expect(starts).toBe(intent === "different" ? 2 : 1);
      const grant = f.dispatcher.consumeFreshLaunch(f.session, 987);
      if (intent === "same") expect(grant).toMatchObject({ agentPid: 987 });
      else expect(grant).toBeNull();
    },
  );

  it.each(["consume", "exit"] as const)(
    "does not revive a different trusted start after %s invalidates its pending owner",
    async (invalidation) => {
      vi.useFakeTimers();
      let probes = 0;
      let exists = true;
      let release!: () => void;
      const launched = new Promise<void>((resolve) => {
        release = resolve;
      });
      let starts = 0;
      const f = fixture(
        async () => (++probes === 1 || !exists ? absent : live),
        async () => {
          if (++starts === 1) await launched;
          else exists = true;
        },
        1000,
      );
      f.codex.isFreshStartCommand = (command?: string) =>
        command === "codex --yolo" || command === "codex --full-auto";
      const first = f.dispatcher.start(f.session, "codex --yolo");
      await vi.advanceTimersByTimeAsync(0);
      const second = f.dispatcher.start(f.session, "codex --full-auto").then(
        () => false,
        () => true,
      );
      await vi.advanceTimersByTimeAsync(0);
      if (invalidation === "exit") await f.dispatcher.exit(f.session);
      else f.dispatcher.consumeFreshLaunch(f.session, -1);
      exists = false;
      release();
      await first;
      expect(await second).toBe(true);
      expect(starts).toBe(1);
      expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
    },
  );

  it("bounds routing before any launch continuation", async () => {
    vi.useFakeTimers();
    let route!: (session: string) => void;
    const bridge = {
      resolveSessionName: () =>
        new Promise<string>((resolve) => {
          route = resolve;
        }),
    };
    const codex = Object.assign(fakeRunner("codex"), { isFreshStartCommand: (): boolean => true });
    const dispatcher = new AgentRunnerDispatcher({
      bridge: bridge as never,
      codex,
      claude: fakeRunner("claude"),
      configResolver: fakeConfigResolver(),
      maxWaitReadyMs: 50,
    });
    let settled = false;
    const pending = dispatcher.start("tmux_proj_route").catch(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(true);
    } finally {
      route("tmux_proj_route");
      await pending;
    }
    expect(codex.calls).not.toContain("start");
  });

  it("gives the real Codex readiness wait only the remaining original budget", async () => {
    vi.useFakeTimers();
    const session = "tmux_proj_real_budget";
    setAgentKind(session, "codex");
    let probes = 0;
    const resolver = Object.assign(fakeConfigResolver(), {
      resolveLiveAgentIdentity: async () => {
        if (++probes === 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return absent;
        }
        return live;
      },
    });
    const bridge = {
      resolveSessionName: async () => session,
      sendRawKey: vi.fn(async () => {}),
      sendKeys: vi.fn(async () => {}),
      capturePane: async () => "Booting",
    };
    const codex = new CodexRunner({
      bridge: bridge as never,
      output: {} as never,
      configResolver: resolver,
      codexCommand: "codex",
      idlePollTicks: 3,
      pollIntervalMs: 10,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 50,
    });
    const dispatcher = new AgentRunnerDispatcher({
      bridge: bridge as never,
      codex,
      claude: fakeRunner("claude"),
      configResolver: resolver,
      maxWaitReadyMs: 50,
    });
    let settled = false;
    const pending = dispatcher.start(session).then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(true);
    } finally {
      await vi.advanceTimersByTimeAsync(100);
      await pending;
    }
    expect(bridge.sendKeys).toHaveBeenCalledTimes(1);
    expect(dispatcher.consumeFreshLaunch(session, 987)).toBeNull();
  });

  it("does not send startup confirmation keys from a capture that returns after the deadline", async () => {
    vi.useFakeTimers();
    const session = "tmux_proj_late_gate";
    setAgentKind(session, "codex");
    const resolver = Object.assign(fakeConfigResolver(), {
      resolveLiveAgentIdentity: async () => absent,
    });
    const bridge = {
      resolveSessionName: async () => session,
      sendRawKey: vi.fn(async () => {}),
      sendKeys: vi.fn(async () => {}),
      capturePane: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return "Do you trust the contents of this directory?\n  1. Yes, continue\n  Press enter to continue";
      },
    };
    const codex = new CodexRunner({
      bridge: bridge as never,
      output: {} as never,
      configResolver: resolver,
      codexCommand: "codex",
      idlePollTicks: 3,
      pollIntervalMs: 10,
      maxWaitReadyMs: 50,
      maxWaitDoneMs: 50,
    });
    const dispatcher = new AgentRunnerDispatcher({
      bridge: bridge as never,
      codex,
      claude: fakeRunner("claude"),
      configResolver: resolver,
      maxWaitReadyMs: 50,
    });
    const pending = dispatcher.start(session);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(bridge.sendRawKey.mock.calls).toEqual([["C-u", session]]);
    expect(dispatcher.consumeFreshLaunch(session, 987)).toBeNull();
  });

  it("waits for exact native PID visibility after UI-ready launch", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const f = fixture(async () => (++probes < 3 ? absent : live), undefined, 1000);
    const pending = f.dispatcher.start(f.session);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(probes).toBe(3);
    expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toMatchObject({ agentPid: 987 });
  });
  it("preserves an unused same-process grant across an idempotent start after long external work", async () => {
    let probes = 0;
    const f = fixture(async () => (++probes === 1 ? absent : live));
    await f.dispatcher.start(f.session);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 21 * 60 * 1000);
    await f.dispatcher.start(f.session);
    expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toMatchObject({
      agentPid: 987,
      generation: 1,
    });
    expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
  });
  it.each(["before", "after"] as const)(
    "bounds a stalled %s identity query by the original readiness horizon",
    async (stage) => {
      vi.useFakeTimers();
      let resolve!: (value: typeof live) => void;
      const stalled = new Promise<typeof live>((done) => {
        resolve = done;
      });
      let probes = 0;
      const f = fixture(async () => (++probes === 1 && stage === "after" ? absent : stalled));
      let settled = false;
      const pending = f.dispatcher.start(f.session).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(true);
        expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
      } finally {
        resolve(live);
        await pending;
      }
      expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
    },
  );
  it("uses one readiness horizon across pre-probe, launch, and post-probe", async () => {
    vi.useFakeTimers();
    let probes = 0;
    const f = fixture(
      async () => {
        probes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return probes === 1 ? absent : live;
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );
    let settled = false;
    const pending = f.dispatcher.start(f.session).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(true);
    expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
  });

  it("does not mint a delayed grant after any prompt attempt invalidates pending registration", async () => {
    let finish!: () => void;
    const started = new Promise<void>((done) => {
      finish = done;
    });
    let probes = 0;
    const f = fixture(
      async () => (++probes === 1 ? absent : live),
      () => started,
    );
    const pending = f.dispatcher.start(f.session);
    await vi.waitFor(() => expect(probes).toBe(1));
    expect(f.dispatcher.consumeFreshLaunch(f.session, -1)).toBeNull();
    finish();
    await pending;
    expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
  });
  it.each(["unknown", "existing", "history", "untrusted"] as const)(
    "does not adopt %s pre-start evidence",
    async (evidence) => {
      let probes = 0;
      const f = fixture(async () => {
        probes += 1;
        if (probes > 1) return live;
        if (evidence === "unknown") return null;
        if (evidence === "existing") return live;
        if (evidence === "history")
          return { ...live, transcript: { path: "/fixture/rollout.jsonl", sessionId: "fixture" } };
        return absent;
      });
      if (evidence === "untrusted") f.codex.isFreshStartCommand = () => false;
      await f.dispatcher.start(f.session);
      expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
      expect(probes).toBe(evidence === "untrusted" ? 0 : 1);
    },
  );

  it.each(["pid", "history", "unknown", "consumed", "untrusted"] as const)(
    "invalidates an existing grant for %s evidence during repeat start",
    async (change) => {
      let probes = 0;
      let afterRepeat = false;
      const f = fixture(async () => {
        probes += 1;
        if (probes === 1) return absent;
        if (!afterRepeat || probes === 3) return live;
        if (change === "pid") return { ...live, agentPid: 988 };
        if (change === "history")
          return { ...live, transcript: { path: "/fixture/rollout.jsonl", sessionId: "fixture" } };
        if (change === "unknown") return null;
        return live;
      });
      await f.dispatcher.start(f.session);
      afterRepeat = true;
      if (change === "consumed")
        f.codex.start = async () => {
          f.dispatcher.consumeFreshLaunch(f.session, -1);
        };
      if (change === "untrusted") f.codex.isFreshStartCommand = () => false;
      await f.dispatcher.start(f.session);
      expect(f.dispatcher.consumeFreshLaunch(f.session, 987)).toBeNull();
    },
  );
});
