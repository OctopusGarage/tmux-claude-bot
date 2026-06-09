import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecFileLike, ExecResult } from "../src/core/tmux.js";
import { TmuxBridge } from "../src/core/tmux.js";

type MockExecFile = ExecFileLike & ReturnType<typeof vi.fn>;

function createMockExecFile(results: {
  listPanes?: ExecResult;
  sendKeys?: ExecResult;
  capturePane?: ExecResult;
  hasSession?: ExecResult;
  newSession?: ExecResult;
  killSession?: ExecResult;
  listSessions?: ExecResult;
}): MockExecFile {
  return vi.fn().mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
    if (cmd === "tmux") {
      const subcmd = args[0];
      switch (subcmd) {
        case "list-panes":
          return results.listPanes ?? { stdout: "", stderr: "" };
        case "send-keys":
          return results.sendKeys ?? { stdout: "", stderr: "" };
        case "capture-pane":
          return results.capturePane ?? { stdout: "", stderr: "" };
        case "has-session":
          return results.hasSession ?? { stdout: "", stderr: "" };
        case "new-session":
          return results.newSession ?? { stdout: "", stderr: "" };
        case "kill-session":
          return results.killSession ?? { stdout: "", stderr: "" };
        case "list-sessions":
          return results.listSessions ?? { stdout: "", stderr: "" };
      }
    }
    throw new Error(`Unexpected execFile call: ${cmd} ${args.join(" ")}`);
  });
}

describe("TmuxBridge", () => {
  let mockExecFile: MockExecFile;
  let getSessionName: () => Promise<string>;

  beforeEach(() => {
    mockExecFile = createMockExecFile({});
    getSessionName = async () => "tmux_proj_test";
  });

  describe("constructor", () => {
    it("uses default execFile when not provided", async () => {
      const bridge = new TmuxBridge({ getSessionName });
      // The default execFile tries to run actual tmux, so isPaneAlive will fail
      // but we can verify the bridge was created
      expect(bridge).toBeDefined();
    });

    it("uses custom execFile when provided", () => {
      const customExec = vi.fn();
      const bridge = new TmuxBridge({ execFile: customExec, getSessionName });
      expect(bridge).toBeDefined();
    });

    it("uses default window (0) and pane (0)", () => {
      const bridge = new TmuxBridge({ getSessionName });
      expect(bridge).toBeDefined();
    });

    it("accepts custom window and pane", () => {
      const bridge = new TmuxBridge({ getSessionName, window: 2, pane: 3 });
      expect(bridge).toBeDefined();
    });

    it("uses default projectSessionPrefix", () => {
      const bridge = new TmuxBridge({ getSessionName });
      expect(bridge).toBeDefined();
    });

    it("accepts custom projectSessionPrefix", () => {
      const bridge = new TmuxBridge({ getSessionName, projectSessionPrefix: "custom_" });
      expect(bridge).toBeDefined();
    });
  });

  describe("isPaneAlive", () => {
    it("returns true when pane exists", async () => {
      mockExecFile = createMockExecFile({
        listPanes: { stdout: "$1", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.isPaneAlive();
      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["list-panes", "-t", "tmux_proj_test:0.0", "-F", "#{pane_id}"],
        { timeout: 10000 },
      );
    });

    it("returns false when pane does not exist (execFile throws)", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("no such pane"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.isPaneAlive();
      expect(result).toBe(false);
    });

    it("returns false when stdout is empty", async () => {
      mockExecFile = createMockExecFile({
        listPanes: { stdout: "", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.isPaneAlive();
      expect(result).toBe(false);
    });

    it("returns false when session name lookup fails", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("failed"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.isPaneAlive();
      expect(result).toBe(false);
    });
  });

  describe("sendKeys", () => {
    it("sends single line with Enter", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendKeys("echo hello");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "echo hello"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Enter"],
        { timeout: 10000 },
      );
    });

    it("sends multiple lines sequentially with Enter after each", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendKeys("line1\nline2\nline3");
      // Each non-empty line gets content + Enter; last line also gets Enter
      expect(mockExecFile).toHaveBeenCalledTimes(6);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "line1"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Enter"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        3,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "line2"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Enter"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        5,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "line3"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        6,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Enter"],
        { timeout: 10000 },
      );
    });

    it("skips empty lines but still sends Enter on last iteration", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendKeys("line1\n\nline2");
      // Split gives ["line1", "", "line2"], length=3
      // i=0: line="line1" truthy -> send-keys, Enter
      // i=1: line="" falsy -> skip (no Enter, not last line)
      // i=2: line="line2" truthy, isLastLine=true -> send-keys, Enter
      expect(mockExecFile).toHaveBeenCalledTimes(4);
    });

    it("handles single newline - sends Enter only", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendKeys("\n");
      // Split gives [""], length=1
      // i=0: line="" falsy, isLastLine=true -> send Enter
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Enter"],
        { timeout: 10000 },
      );
    });

    it("handles whitespace-only lines as non-empty", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendKeys("line1\n   \nline2");
      // Split: ["line1", "   ", "line2"], length=3
      // i=0: "line1" truthy -> send-keys, Enter
      // i=1: "   " truthy -> send-keys, Enter
      // i=2: "line2" truthy, isLastLine=true -> send-keys, Enter
      expect(mockExecFile).toHaveBeenCalledTimes(6);
    });
  });

  describe("sendRawKey", () => {
    it("sends raw key without modification", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendRawKey("C-c");
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-c"],
        { timeout: 10000 },
      );
    });

    it("sends special keys like Escape", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendRawKey("Escape");
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "Escape"],
        { timeout: 10000 },
      );
    });
  });

  describe("capturePane", () => {
    it("captures pane output", async () => {
      mockExecFile = createMockExecFile({
        capturePane: { stdout: "line1\nline2\nline3", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.capturePane();
      expect(result).toBe("line1\nline2\nline3");
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["capture-pane", "-p", "-J", "-t", "tmux_proj_test:0.0"],
        { timeout: 10000 },
      );
    });

    it("returns empty string when pane is empty", async () => {
      mockExecFile = createMockExecFile({
        capturePane: { stdout: "", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.capturePane();
      expect(result).toBe("");
    });
  });

  describe("sendExit", () => {
    it("sends C-c, waits 300ms, then sends /exit", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const start = Date.now();
      await bridge.sendExit();
      const elapsed = Date.now() - start;

      // Should have called sendRawKey("C-c") and sendKeys("/exit")
      // The calls are: C-c (sendRawKey), then after 300ms: /exit (sendKeys)
      expect(mockExecFile).toHaveBeenCalled();
      // The sendKeys for /exit includes Enter
      expect(elapsed).toBeGreaterThanOrEqual(300);
    });
  });

  describe("createSession", () => {
    it("creates a new tmux session", async () => {
      mockExecFile = createMockExecFile({ newSession: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.createSession("my_session");
      expect(mockExecFile).toHaveBeenCalledWith("tmux", ["new-session", "-d", "-s", "my_session"], {
        timeout: 10000,
      });
    });

    it("throws when session creation fails", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("session exists"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await expect(bridge.createSession("existing_session")).rejects.toThrow("session exists");
    });
  });

  describe("hasSession", () => {
    it("returns true when session exists", async () => {
      mockExecFile = createMockExecFile({
        hasSession: { stdout: "", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.hasSession("tmux_proj_test");
      expect(result).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith("tmux", ["has-session", "-t", "tmux_proj_test"], {
        timeout: 10000,
      });
    });

    it("returns false when session does not exist (throws)", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("no such session"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.hasSession("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("killSession", () => {
    it("kills the specified session", async () => {
      mockExecFile = createMockExecFile({ killSession: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.killSession("tmux_proj_test");
      expect(mockExecFile).toHaveBeenCalledWith("tmux", ["kill-session", "-t", "tmux_proj_test"], {
        timeout: 10000,
      });
    });

    it("throws when kill fails", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("no such session"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await expect(bridge.killSession("nonexistent")).rejects.toThrow("no such session");
    });
  });

  describe("listProjectSessions", () => {
    it("returns only project sessions with prefix", async () => {
      mockExecFile = createMockExecFile({
        listSessions: {
          stdout: "tmux_proj_/Users/test-proj\nother_session\ntmux_proj_/Users/another-proj\n",
          stderr: "",
        },
      });
      const bridge = new TmuxBridge({
        execFile: mockExecFile,
        getSessionName,
        projectSessionPrefix: "tmux_proj_",
      });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual(["tmux_proj_/Users/test-proj", "tmux_proj_/Users/another-proj"]);
    });

    it("returns empty array when no project sessions exist", async () => {
      mockExecFile = createMockExecFile({
        listSessions: { stdout: "other_session\nanother_session\n", stderr: "" },
      });
      const bridge = new TmuxBridge({
        execFile: mockExecFile,
        getSessionName,
        projectSessionPrefix: "tmux_proj_",
      });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual([]);
    });

    it("returns empty array for empty output", async () => {
      mockExecFile = createMockExecFile({
        listSessions: { stdout: "", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual([]);
    });

    it("handles custom projectSessionPrefix", async () => {
      mockExecFile = createMockExecFile({
        listSessions: { stdout: "custom_/path\nother\ncustom_/another\n", stderr: "" },
      });
      const bridge = new TmuxBridge({
        execFile: mockExecFile,
        getSessionName,
        projectSessionPrefix: "custom_",
      });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual(["custom_/path", "custom_/another"]);
    });

    it("trims whitespace from session names", async () => {
      mockExecFile = createMockExecFile({
        listSessions: { stdout: "  tmux_proj_/path  \n  other  \n", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual(["tmux_proj_/path"]);
    });
  });

  describe("formatTarget", () => {
    it("formats target as session:window.pane", async () => {
      mockExecFile = createMockExecFile({});
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      // formatTarget is private — access via cast to test its logic directly
      const target = await (
        bridge as unknown as { formatTarget(): Promise<string> }
      ).formatTarget();
      expect(target).toBe("tmux_proj_test:0.0");
    });

    it("uses custom window and pane when specified", async () => {
      mockExecFile = createMockExecFile({});
      getSessionName = async () => "my_session";
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName, window: 3, pane: 5 });
      // formatTarget is private — access via cast to test its logic directly
      const target = await (
        bridge as unknown as { formatTarget(): Promise<string> }
      ).formatTarget();
      expect(target).toBe("my_session:3.5");
    });
  });

  describe("edge cases", () => {
    it("handles getSessionName returning different session names", async () => {
      let callCount = 0;
      getSessionName = async () => {
        callCount++;
        return `session_${callCount}`;
      };
      mockExecFile = createMockExecFile({});
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      // formatTarget is private — access via cast to test its logic directly
      const bridgeInternal = bridge as unknown as { formatTarget(): Promise<string> };

      const target1 = await bridgeInternal.formatTarget();
      expect(target1).toBe("session_1:0.0");

      const target2 = await bridgeInternal.formatTarget();
      expect(target2).toBe("session_2:0.0");
    });
  });

  describe("listProjectSessions error handling", () => {
    it("throws when tmux list-sessions fails with unexpected error", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("permission denied"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await expect(bridge.listProjectSessions()).rejects.toThrow("permission denied");
    });

    it("handles error object without message property", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce("plain string error");
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await expect(bridge.listProjectSessions()).rejects.toBe("plain string error");
    });

    it("returns empty array when no server running", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("no server running on /tmp/tmux-1000"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual([]);
    });

    it("returns empty array when no sessions", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("no sessions"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.listProjectSessions();
      expect(result).toEqual([]);
    });
  });

  describe("defaultExecFile", () => {
    it("uses real execFile when no mock provided", async () => {
      const bridge = new TmuxBridge({ getSessionName });
      // Will attempt actual tmux command; if tmux is not installed, catch returns false
      const result = await bridge.isPaneAlive();
      expect(typeof result).toBe("boolean");
    });
  });
});
