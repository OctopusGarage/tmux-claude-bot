import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver } from "../src/core/agents/agent-config-resolver.js";
import { setAgentKind } from "../src/core/agents/agentKindMap.js";
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
