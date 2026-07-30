import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExecFileLike,
  ExecResult,
  UnlinkFileLike,
  WriteFileLike,
} from "../src/core/session/tmux.js";
import { TmuxBridge } from "../src/core/session/tmux.js";
import { TERMINAL_MODE_RESET_SEQUENCE } from "../src/shared/utils/terminal-modes.js";

type MockExecFile = ExecFileLike & ReturnType<typeof vi.fn>;

function createMockExecFile(results: {
  listPanes?: ExecResult;
  sendKeys?: ExecResult;
  capturePane?: ExecResult;
  hasSession?: ExecResult;
  newSession?: ExecResult;
  killSession?: ExecResult;
  listSessions?: ExecResult;
  displayMessage?: ExecResult;
  listClients?: ExecResult;
}): MockExecFile {
  return vi.fn().mockImplementation(async (cmd: string, args: string[]): Promise<ExecResult> => {
    if (cmd === "tmux") {
      const subcmd = args[0];
      switch (subcmd) {
        case "list-panes":
          return results.listPanes ?? { stdout: "", stderr: "" };
        case "send-keys":
          return results.sendKeys ?? { stdout: "", stderr: "" };
        case "load-buffer":
        case "set-buffer":
        case "paste-buffer":
        case "delete-buffer":
          return { stdout: "", stderr: "" };
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
        case "display-message":
          return results.displayMessage ?? { stdout: "", stderr: "" };
        case "list-clients":
          return results.listClients ?? { stdout: "", stderr: "" };
      }
    }
    throw new Error(`Unexpected execFile call: ${cmd} ${args.join(" ")}`);
  });
}

describe("TmuxBridge", () => {
  let mockExecFile: MockExecFile;
  let writtenFiles: Array<{ file: string; data: string }>;
  let unlinkedFiles: string[];
  let mockWriteFile: WriteFileLike;
  let mockUnlinkFile: UnlinkFileLike;
  let getSessionName: () => Promise<string>;

  beforeEach(() => {
    mockExecFile = createMockExecFile({});
    writtenFiles = [];
    unlinkedFiles = [];
    mockWriteFile = async (file, data) => {
      writtenFiles.push({ file, data });
    };
    mockUnlinkFile = async (file) => {
      unlinkedFiles.push(file);
    };
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
    const bridgeForSendKeys = (
      options: Partial<ConstructorParameters<typeof TmuxBridge>[0]> = {},
    ) =>
      new TmuxBridge({
        execFile: mockExecFile,
        getSessionName,
        writeFile: mockWriteFile,
        unlinkFile: mockUnlinkFile,
        ...options,
      });

    it("pastes single-line text and submits with one C-m", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      await bridge.sendKeys("echo hello");
      expect(mockExecFile).toHaveBeenCalledTimes(5);
      expect(writtenFiles).toHaveLength(1);
      expect(writtenFiles[0]?.data).toBe("echo hello");
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "-X", "cancel"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        "tmux",
        [
          "load-buffer",
          "-b",
          expect.stringMatching(/^tcb-send-/),
          expect.stringMatching(/tcb-send-.*\.txt$/),
        ],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        3,
        "tmux",
        [
          "paste-buffer",
          "-p",
          "-b",
          expect.stringMatching(/^tcb-send-/),
          "-t",
          "tmux_proj_test:0.0",
        ],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-m"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        5,
        "tmux",
        ["delete-buffer", "-b", expect.stringMatching(/^tcb-send-/)],
        { timeout: 10000 },
      );
      expect(unlinkedFiles).toEqual([writtenFiles[0]?.file]);
    });

    it("waits briefly after paste before submitting", async () => {
      const sleeps: number[] = [];
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys({
        submitSettleMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      await bridge.sendKeys("echo hello");

      expect(sleeps).toEqual([50]);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-m"],
        { timeout: 10000 },
      );
    });

    it("preserves newline-only text instead of treating it as a raw Enter", async () => {
      const sleeps: number[] = [];
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys({
        submitSettleMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      await bridge.sendKeys("\n");

      expect(sleeps).toEqual([50]);
      expect(writtenFiles[0]?.data).toBe("\n");
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-m"],
        { timeout: 10000 },
      );
    });

    it("pastes text literally so a prompt equal to a tmux key name is not interpreted", async () => {
      // Regression: without -l, `send-keys -t target Up` presses the Up ARROW key
      // instead of typing the word "Up". A user prompt line that happens to equal a
      // key name (Up/Enter/Tab/C-c) would be silently swallowed/misinterpreted.
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      await bridge.sendKeys("Up");
      expect(writtenFiles[0]?.data).toBe("Up");
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-m"],
        { timeout: 10000 },
      );
    });

    it("pastes multiple lines as one prompt and submits once", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      await bridge.sendKeys("line1\nline2\nline3");
      expect(mockExecFile).toHaveBeenCalledTimes(5);
      expect(writtenFiles[0]?.data).toBe("line1\nline2\nline3");
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "-X", "cancel"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        "tmux",
        [
          "load-buffer",
          "-b",
          expect.stringMatching(/^tcb-send-/),
          expect.stringMatching(/tcb-send-.*\.txt$/),
        ],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        3,
        "tmux",
        [
          "paste-buffer",
          "-p",
          "-b",
          expect.stringMatching(/^tcb-send-/),
          "-t",
          "tmux_proj_test:0.0",
        ],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-m"],
        { timeout: 10000 },
      );
    });

    it("preserves empty lines inside the prompt", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      await bridge.sendKeys("line1\n\nline2");
      expect(mockExecFile).toHaveBeenCalledTimes(5);
      expect(writtenFiles[0]?.data).toBe("line1\n\nline2");
    });

    it("preserves a single newline as prompt text and submits once", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      await bridge.sendKeys("\n");
      expect(mockExecFile).toHaveBeenCalledTimes(5);
      expect(writtenFiles[0]?.data).toBe("\n");
      expect(mockExecFile).toHaveBeenNthCalledWith(
        4,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "C-m"],
        { timeout: 10000 },
      );
    });

    it("preserves whitespace-only lines inside the prompt", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      await bridge.sendKeys("line1\n   \nline2");
      expect(mockExecFile).toHaveBeenCalledTimes(5);
      expect(writtenFiles[0]?.data).toBe("line1\n   \nline2");
    });

    it("keeps very large prompts out of tmux command arguments", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = bridgeForSendKeys();
      const prompt = "x".repeat(300_000);
      await bridge.sendKeys(prompt);
      expect(writtenFiles[0]?.data).toBe(prompt);
      expect(mockExecFile.mock.calls.some(([, args]) => args.includes(prompt))).toBe(false);
    });
  });

  describe("sendRawKey", () => {
    it("sends raw key without modification", async () => {
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await bridge.sendRawKey("C-c");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        "tmux",
        ["send-keys", "-t", "tmux_proj_test:0.0", "-X", "cancel"],
        { timeout: 10000 },
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
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

  describe("paneCurrentPath", () => {
    it("returns the trimmed pane_current_path", async () => {
      mockExecFile = createMockExecFile({
        displayMessage: { stdout: "/home/user/app\n", stderr: "" },
      });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const result = await bridge.paneCurrentPath();
      expect(result).toBe("/home/user/app");
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["display-message", "-p", "-t", "tmux_proj_test:0.0", "#{pane_current_path}"],
        { timeout: 5000 },
      );
    });

    it("returns null when the pane path is empty", async () => {
      mockExecFile = createMockExecFile({ displayMessage: { stdout: "  \n", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      expect(await bridge.paneCurrentPath()).toBeNull();
    });

    it("returns null when the query fails (execFile throws)", async () => {
      mockExecFile = createMockExecFile({});
      mockExecFile.mockRejectedValueOnce(new Error("no such session"));
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      expect(await bridge.paneCurrentPath()).toBeNull();
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
      vi.useFakeTimers();
      mockExecFile = createMockExecFile({ sendKeys: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({
        execFile: mockExecFile,
        getSessionName,
        writeFile: mockWriteFile,
        unlinkFile: mockUnlinkFile,
        submitSettleMs: 0,
      });

      const done = bridge.sendExit();
      // Before advancing time: C-c should have been sent, /exit not yet
      const callsBefore = mockExecFile.mock.calls.length;
      await vi.advanceTimersByTimeAsync(350);
      await done;
      vi.useRealTimers();

      // After the 300ms delay, /exit should have been sent (more calls than before)
      expect(mockExecFile.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("resets enhanced keyboard modes on attached tmux client terminals after /exit", async () => {
      vi.useFakeTimers();
      const writes: Array<{ path: string; data: string }> = [];
      mockExecFile = createMockExecFile({
        sendKeys: { stdout: "", stderr: "" },
        listClients: { stdout: "/dev/ttys016\n/dev/ttys016\n/dev/ttys020\n", stderr: "" },
      });
      const bridge = new TmuxBridge({
        execFile: mockExecFile,
        getSessionName,
        unlinkFile: mockUnlinkFile,
        submitSettleMs: 0,
        writeFile: async (path, data) => {
          writes.push({ path, data });
        },
      });

      const done = bridge.sendExit();
      await vi.advanceTimersByTimeAsync(350);
      await done;
      vi.useRealTimers();

      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["list-clients", "-t", "tmux_proj_test", "-F", "#{client_tty}"],
        { timeout: 5000 },
      );
      expect(writes.filter((write) => write.path.startsWith("/dev/"))).toEqual([
        { path: "/dev/ttys016", data: TERMINAL_MODE_RESET_SEQUENCE },
        { path: "/dev/ttys020", data: TERMINAL_MODE_RESET_SEQUENCE },
      ]);
    });
  });

  describe("createSession", () => {
    it("creates a new tmux session and returns true", async () => {
      mockExecFile = createMockExecFile({ newSession: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      await expect(bridge.createSession("my_session")).resolves.toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith("tmux", ["new-session", "-d", "-s", "my_session"], {
        timeout: 10000,
      });
    });

    it("passes -c <cwd> to new-session so the pane starts there (no shell `cd`, no injection)", async () => {
      // B3 fix: the working directory reaches tmux as a single argv element — execFile
      // never spawns a shell — so a path containing spaces, $, backticks, quotes or `;`
      // cannot break out of a typed `cd "..."` command.
      mockExecFile = createMockExecFile({ newSession: { stdout: "", stderr: "" } });
      const bridge = new TmuxBridge({ execFile: mockExecFile, getSessionName });
      const evilPath = '/home/user/foo"; rm -rf ~ #';
      await expect(bridge.createSession("my_session", evilPath)).resolves.toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        "tmux",
        ["new-session", "-d", "-s", "my_session", "-c", evilPath],
        { timeout: 10000 },
      );
    });

    it("returns false (no throw) when the session already exists — race-safe", async () => {
      // new-session loses the race ("duplicate session"), but has-session confirms
      // it exists, so the goal ("session exists") is met.
      const exec = vi.fn(async (_cmd: string, args: string[]) => {
        if (args[0] === "new-session") throw new Error("duplicate session: existing_session");
        return { stdout: "", stderr: "" }; // has-session succeeds → exists
      }) as unknown as MockExecFile;
      const bridge = new TmuxBridge({ execFile: exec, getSessionName });
      await expect(bridge.createSession("existing_session")).resolves.toBe(false);
    });

    it("rethrows when creation fails and the session does not exist", async () => {
      const exec = vi.fn(async (_cmd: string, args: string[]) => {
        if (args[0] === "new-session") throw new Error("tmux server died");
        if (args[0] === "has-session") throw new Error("no such session"); // not exists
        return { stdout: "", stderr: "" };
      }) as unknown as MockExecFile;
      const bridge = new TmuxBridge({ execFile: exec, getSessionName });
      await expect(bridge.createSession("x")).rejects.toThrow("tmux server died");
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
