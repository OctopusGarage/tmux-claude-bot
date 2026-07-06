import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResolver } from "../src/core/agents/agent-config-resolver.js";
import { ClaudeRunner } from "../src/core/agents/claude/claude-runner.js";
import { OutputProcessor } from "../src/core/session/output.js";
import type { ExecResult } from "../src/core/session/tmux.js";
import { TmuxBridge } from "../src/core/session/tmux.js";

function createMockResolver(): ConfigResolver {
  return {
    resolveConfigRoot: vi.fn(async () => "/home/.claude"),
    isClaudeRunning: vi.fn(async () => false),
    isCodexRunning: vi.fn(async () => false),
    invalidate: vi.fn(),
  };
}

function createMockBridge(
  mockExecFile: ReturnType<typeof vi.fn>,
  getSessionName: () => Promise<string>,
): TmuxBridge {
  return new TmuxBridge({ execFile: mockExecFile as any, getSessionName });
}

function createOutputProcessor(maxOutputLines = 100, maxMessageLength = 4000): OutputProcessor {
  return new OutputProcessor({ maxOutputLines, maxMessageLength });
}

describe("ClaudeRunner", () => {
  let mockExecFile: ReturnType<typeof vi.fn>;
  let getSessionName: () => Promise<string>;
  let bridge: TmuxBridge;
  let output: OutputProcessor;
  let mockResolver: ConfigResolver;
  let runner: ClaudeRunner;

  const defaultOptions = {
    claudeCommand: "/opt/homebrew/bin/claude",
    idlePollTicks: 3,
    pollIntervalMs: 100,
    maxWaitReadyMs: 5000,
    maxWaitDoneMs: 10000,
  };

  beforeEach(() => {
    mockExecFile = vi
      .fn()
      .mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux") {
          if (args[0] === "capture-pane") {
            return { stdout: "", stderr: "" };
          }
          if (args[0] === "send-keys") {
            return { stdout: "", stderr: "" };
          }
        }
        return { stdout: "", stderr: "" };
      });
    getSessionName = async () => "tmux_proj_test";
    bridge = createMockBridge(mockExecFile, getSessionName);
    output = createOutputProcessor();
    mockResolver = createMockResolver();
  });

  describe("constructor", () => {
    it("creates runner with all options", () => {
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      expect(runner).toBeDefined();
    });
  });

  describe("checkIfRunning (process-based, delegates to the config resolver)", () => {
    it("returns true when the resolver reports a claude process in the pane", async () => {
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      expect(await runner.checkIfRunning("tmux_proj_x")).toBe(true);
      expect(mockResolver.isClaudeRunning).toHaveBeenCalledWith("tmux_proj_x");
    });

    it("returns false when the resolver reports no claude process", async () => {
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      expect(await runner.checkIfRunning("tmux_proj_x")).toBe(false);
    });

    it("resolves the default session name when none is given", async () => {
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.checkIfRunning();
      expect(mockResolver.isClaudeRunning).toHaveBeenCalledWith("tmux_proj_test");
    });
  });

  describe("start", () => {
    it("does not re-send the start command when claude is already running", async () => {
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      let sendKeysCalled = false;
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux" && args[0] === "send-keys") {
          sendKeysCalled = true;
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.start();
      expect(sendKeysCalled).toBe(false);
    });

    it("sends claude command when not running", async () => {
      let sendKeysCalled = false;
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux" && args[0] === "capture-pane") {
          return { stdout: "❯ ", stderr: "" }; // ready composer
        }
        if (cmd === "tmux" && args[0] === "send-keys") {
          sendKeysCalled = true;
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.start();
      expect(sendKeysCalled).toBe(true);
    });

    it("clears the trust-directory gate on start (sends Enter)", async () => {
      // Claude shows the same one-time trust-directory gate as codex; it blocks
      // input until accepted, so start() must clear it (send Enter) before the
      // first message — handled by the shared base, not codex-only. The pane text
      // is the REAL claude gate (live-captured): its wording differs from codex's
      // and contains NO "Do you trust" — see paneNeedsTrust. After Enter, the real
      // composer (with the "❯" prompt) renders → ready.
      const sentKeys: string[] = [];
      let captures = 0;
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux") {
          if (args[0] === "capture-pane") {
            captures++;
            return {
              stdout:
                captures < 2
                  ? "Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit"
                  : "────────\n❯ \n────────",
              stderr: "",
            };
          }
          if (args[0] === "send-keys") sentKeys.push(args[args.length - 1] ?? "");
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        pollIntervalMs: 5,
      });
      await runner.start();
      expect(sentKeys).toContain("Enter"); // accepted the trust gate
    });

    it("selects Yes on the bypass-permissions gate and ignores stale gate text", async () => {
      const sentKeys: string[] = [];
      let captures = 0;
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux") {
          if (args[0] === "capture-pane") {
            captures++;
            if (captures === 1) {
              return {
                stdout:
                  "WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ 1. No, exit\n    2. Yes, I accept\n\n  Enter to confirm · Esc to cancel",
                stderr: "",
              };
            }
            if (captures === 2) {
              return {
                stdout:
                  "WARNING: Claude Code running in Bypass Permissions mode\n\n  ❯ 1. No, exit\n    2. Yes, I accept\n\n  Enter to confirm · Esc to cancel\n(base) user@host:~/repo|main ⇒",
                stderr: "",
              };
            }
            return { stdout: "────────\n❯ \n────────", stderr: "" };
          }
          if (args[0] === "send-keys") sentKeys.push(args[args.length - 1] ?? "");
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        pollIntervalMs: 5,
      });

      await runner.start();

      expect(sentKeys.filter((key) => key === "Down")).toHaveLength(1);
      expect(sentKeys.slice(-2)).toEqual(["Down", "Enter"]);
    });
  });

  describe("waitUntilReady", () => {
    it("returns when bypass permissions is visible", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          callCount++;
          return { stdout: "bypass permissions UI shown", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.waitUntilReady();
      expect(callCount).toBeGreaterThanOrEqual(1);
    });

    it("times out on the near-empty boot pane (no composer marker yet)", async () => {
      // Regression: the first second after launch the pane is just the echoed
      // command with no banner. The old "no spinner ⇒ ready" heuristic
      // false-positived this as ready BEFORE the trust gate even rendered
      // (live-verified bug). A positive marker (❯ / bypass) must be required, so a
      // boot pane stays not-ready until the composer paints.
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          return { stdout: "claude\n\n\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        maxWaitReadyMs: 100,
        pollIntervalMs: 10,
      });
      await expect(runner.waitUntilReady()).rejects.toThrow("Claude did not become ready in time");
    });

    it("returns when the composer prompt ❯ is visible", async () => {
      // The real ready composer (live-captured): the "❯" prompt cursor between the
      // box-rule lines. This is the positive marker that the TUI has booted.
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          return { stdout: "────────\n❯ \n────────\n  0% ctx", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await expect(runner.waitUntilReady()).resolves.not.toThrow();
    });

    it("falls back to ready when an UNMARKED pane is stable + substantive + process alive", async () => {
      // Robustness: imagine a future UI re-skin where neither ❯ nor "bypass
      // permissions" appears. A pane that stays byte-identical for idlePollTicks
      // polls, has real content, and whose process is alive must still be treated
      // as ready (prose-agnostic) rather than timing out.
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          // No marker (no ❯, no "bypass permissions"), but 3+ real lines, unchanging.
          return { stdout: "RESKINNED UI\nline two\nline three\nline four", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        idlePollTicks: 3,
        pollIntervalMs: 5,
      });
      await expect(runner.waitUntilReady()).resolves.not.toThrow();
    });

    it("does NOT fall back to ready when the process is not alive (stable but dead)", async () => {
      // The stability fallback is gated on the agent process being alive — a stable
      // pane with no detectable agent (e.g. it crashed to a static error screen)
      // must NOT be declared ready.
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          return { stdout: "static error screen\nline two\nline three\nline four", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        maxWaitReadyMs: 100,
        pollIntervalMs: 10,
        idlePollTicks: 3,
      });
      await expect(runner.waitUntilReady()).rejects.toThrow("Claude did not become ready in time");
    });
  });

  describe("waitUntilDone", () => {
    it("returns processed output when content stabilizes", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          callCount++;
          if (callCount <= 3) {
            return { stdout: `working... ${callCount}`, stderr: "" };
          }
          return { stdout: "final output", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        idlePollTicks: 2,
        pollIntervalMs: 10,
        maxWaitDoneMs: 1000,
      });
      const result = await runner.waitUntilDone();
      expect(result.done).toBe(true);
      expect(result.output).toContain("final output");
    });

    it("reports done=false with the partial output on timeout", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          callCount++;
          // Keeps changing (spinner-style) → never idle → round times out.
          return { stdout: `still working... ${callCount}`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        maxWaitDoneMs: 50,
        pollIntervalMs: 10,
      });
      const result = await runner.waitUntilDone();
      expect(result.done).toBe(false);
      expect(result.output).toContain("still working");
    });

    it("detects idle regardless of spinner when content is stable", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          callCount++;
          if (callCount <= 2) {
            return { stdout: `working... ${callCount}`, stderr: "" };
          }
          // Content stabilizes with spinner present - should still detect idle
          return { stdout: "final output\n⏵⏵ spinner", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        idlePollTicks: 2,
        pollIntervalMs: 10,
        maxWaitDoneMs: 1000,
      });
      const result = await runner.waitUntilDone();
      expect(result.done).toBe(true);
    });

    it("continues polling when capturePane fails", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux" && args[0] === "capture-pane") {
          callCount++;
          if (callCount <= 2) {
            throw new Error("tmux error");
          }
          return { stdout: "final output", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        idlePollTicks: 2,
        pollIntervalMs: 10,
        maxWaitDoneMs: 1000,
      });
      const result = await runner.waitUntilDone();
      expect(result.done).toBe(true);
    });

    it("resets identicalCount when content changes", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          callCount++;
          // Content keeps changing - should never detect idle
          return { stdout: `line ${callCount}`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
        idlePollTicks: 2,
        pollIntervalMs: 10,
        maxWaitDoneMs: 50,
      });
      const result = await runner.waitUntilDone();
      // Should time out; the user-facing notice is the dispatcher's job now.
      expect(result.done).toBe(false);
    });
  });

  describe("interrupt", () => {
    it("sends Escape key", async () => {
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.interrupt();
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Escape"],
        { timeout: 10000 },
      );
    });
  });

  describe("gracefulRestart", () => {
    it("sends exit, waits, then starts again", async () => {
      const calls: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux") {
          const sub = args[0] ?? "";
          calls.push(sub);
          if (sub === "capture-pane") {
            return { stdout: "❯ ", stderr: "" }; // ready composer
          }
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.gracefulRestart();
      // Exits the old session and types a fresh start command.
      expect(calls).toContain("send-keys");
    });
  });

  describe("gracefulRestartWithContinue", () => {
    it("returns early (no --continue typed) if claude is still running after exit", async () => {
      // Process-based check reports claude still alive in the pane.
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      const typed: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        // send-keys typed text is the last positional arg (after -t <target>).
        if (cmd === "tmux" && args[0] === "send-keys") {
          typed.push(args[args.length - 1] ?? "");
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.gracefulRestartWithContinue();
      // The exit sequence (/exit) may go out, but the --continue relaunch must NOT.
      expect(typed.some((t) => t.includes("--continue"))).toBe(false);
    });

    it("sends continue command when not running after exit", async () => {
      const calls: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux") {
          const sub = args[0] ?? "";
          calls.push(sub);
          if (sub === "capture-pane") {
            return { stdout: "❯ ", stderr: "" }; // ready composer
          }
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.gracefulRestartWithContinue();
      // Should have sent the continue command
      expect(calls.filter((c) => c === "send-keys").length).toBeGreaterThanOrEqual(1);
    });

    it("resumes the EXACT live session id (--resume <id>) when the process exposes it", async () => {
      const typed: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux" && args[0] === "send-keys") typed.push(args[args.length - 1] ?? "");
        if (cmd === "tmux" && args[0] === "capture-pane") return { stdout: "❯ ", stderr: "" };
        return { stdout: "", stderr: "" };
      });
      mockResolver.resolveLiveTranscript = vi.fn(async () => ({
        path: "/x.jsonl",
        sessionId: "abcd-1234",
      }));
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.gracefulRestartWithContinue();
      expect(typed.some((t) => t.includes("--resume abcd-1234"))).toBe(true);
      expect(typed.some((t) => t.includes("--continue"))).toBe(false);
    });
  });

  describe("error paths", () => {
    it("returns false when capturePane fails (catch-all error handling)", async () => {
      mockExecFile.mockRejectedValue(new Error("tmux not running"));
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      // checkIfRunning catches errors and returns false
      const result = await runner.checkIfRunning();
      expect(result).toBe(false);
    });
  });
});
