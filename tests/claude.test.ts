import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunner } from "../src/core/claude.js";
import type { ConfigResolver } from "../src/core/claude-config-resolver.js";
import { OutputProcessor } from "../src/core/output.js";
import type { ExecResult } from "../src/core/tmux.js";
import { TmuxBridge } from "../src/core/tmux.js";

function createMockResolver(): ConfigResolver {
  return {
    resolveConfigRoot: vi.fn(async () => "/home/.claude"),
    isClaudeRunning: vi.fn(async () => false),
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
      expect(runner.isRunning()).toBe(false);
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
    it("sets running to true when already running", async () => {
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          return { stdout: "Claude is running...", stderr: "" };
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
      expect(runner.isRunning()).toBe(true);
    });

    it("sends claude command when not running", async () => {
      let sendKeysCalled = false;
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux" && args[0] === "capture-pane") {
          return { stdout: "➜", stderr: "" }; // ➜
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
      expect(runner.isRunning()).toBe(true);
      expect(sendKeysCalled).toBe(true);
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

    it("throws error when timeout reached", async () => {
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          // Include spinner to prevent fallback early-exit
          return { stdout: "still loading...\n⏵⏵ processing", stderr: "" };
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

    it("returns via fallback when no spinner in last two lines", async () => {
      mockExecFile.mockImplementation(async (cmd: string): Promise<ExecResult> => {
        if (cmd === "tmux") {
          return { stdout: "ready prompt\n➜", stderr: "" };
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
            return { stdout: "➜", stderr: "" };
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
      // running is private — set via cast to put runner into the expected initial state
      (runner as unknown as { running: boolean }).running = true;
      await runner.gracefulRestart();
      expect(runner.isRunning()).toBe(true);
      expect(calls).toContain("send-keys");
    });
  });

  describe("gracefulRestartWithContinue", () => {
    it("returns early if claude is still running after exit", async () => {
      // Process-based check reports claude still alive in the pane.
      (mockResolver.isClaudeRunning as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      runner = new ClaudeRunner({
        bridge,
        output,
        configResolver: mockResolver,
        ...defaultOptions,
      });
      await runner.gracefulRestartWithContinue();
      expect(runner.isRunning()).toBe(true);
    });

    it("sends continue command when not running after exit", async () => {
      const calls: string[] = [];
      mockExecFile.mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
        if (cmd === "tmux") {
          const sub = args[0] ?? "";
          calls.push(sub);
          if (sub === "capture-pane") {
            return { stdout: "➜", stderr: "" };
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
      expect(runner.isRunning()).toBe(true);
      // Should have sent the continue command
      expect(calls.filter((c) => c === "send-keys").length).toBeGreaterThanOrEqual(1);
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
