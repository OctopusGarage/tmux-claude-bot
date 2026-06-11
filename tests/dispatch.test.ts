import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertClaudeBinaryAccessible,
  executeMessage,
  type MessageAction,
} from "../src/core/dispatch.js";
import { projectPathToHistoryDir } from "../src/core/history.js";
import type { QueuedMessage } from "../src/core/queue.js";
import { setPathForSession } from "../src/core/sessionPathMap.js";
import { fakeDeps } from "./adapters/lark/_fakes.js";

function msg(action: MessageAction, over: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "1",
    text: "",
    chatId: "c",
    channel: "telegram",
    sessionName: "proj-1",
    action,
    resolve: () => {},
    reject: () => {},
    ...over,
  };
}

function deps(claudeOver: Record<string, unknown> = {}) {
  return fakeDeps({
    claude: {
      checkIfRunning: vi.fn(async () => true),
      waitUntilDone: vi.fn(async () => "PANE"),
      start: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      gracefulRestartWithContinue: vi.fn(async () => {}),
      ...claudeOver,
    } as never,
  });
}

describe("assertClaudeBinaryAccessible", () => {
  it("does not throw when an absolute path binary is executable", () => {
    // /bin/sh is guaranteed to exist and be executable on all POSIX systems
    expect(() => assertClaudeBinaryAccessible("/bin/sh")).not.toThrow();
  });

  it("throws when the absolute path binary does not exist", () => {
    expect(() => assertClaudeBinaryAccessible("/this/binary/does/not/exist/ever")).toThrow(
      /not found or not executable/,
    );
  });

  it("throws when a named binary cannot be found in PATH", () => {
    expect(() => assertClaudeBinaryAccessible("__no_such_binary_xyz_1234__")).toThrow(
      /not found in PATH/,
    );
  });
});

describe("executeMessage — control actions", () => {
  it("no session → done", async () => {
    expect(await executeMessage(msg("status", { sessionName: undefined }), deps())).toBe("完成");
  });

  it("start launches Claude and invalidates the config cache", async () => {
    const d = deps();
    expect(await executeMessage(msg("start"), d)).toBe("✅ Claude 已启动");
    expect(d.claude.start).toHaveBeenCalledWith("proj-1");
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("proj-1");
  });

  it("exit clears the queue, exits Claude, invalidates config", async () => {
    const d = deps();
    expect(await executeMessage(msg("exit"), d)).toBe("✅ 已退出 Claude");
    expect(d.queue.clearSession).toHaveBeenCalledWith("proj-1");
    expect(d.bridge.sendExit).toHaveBeenCalledWith("proj-1");
  });

  it("restart does a graceful --continue restart", async () => {
    const d = deps();
    expect(await executeMessage(msg("restart"), d)).toBe("🔄 Claude 已重启 · --continue");
    expect(d.claude.gracefulRestartWithContinue).toHaveBeenCalledWith("proj-1");
  });

  it("esc interrupts; interrupt sends Ctrl-C; enter/up/down/tab send raw keys", async () => {
    const d = deps();
    expect(await executeMessage(msg("esc"), d)).toBe("✅ 已发送 Esc");
    expect(d.claude.interrupt).toHaveBeenCalledWith("proj-1");
    expect(await executeMessage(msg("interrupt"), d)).toBe("✅ 已中断 · Ctrl-C");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("C-c", "proj-1");
    expect(await executeMessage(msg("enter"), d)).toBe("✅ 已回车");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("C-m", "proj-1");
    expect(await executeMessage(msg("up"), d)).toBe("✅ 已发送 ↑");
    expect(await executeMessage(msg("down"), d)).toBe("✅ 已发送 ↓");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("Up", "proj-1");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("Down", "proj-1");
    expect(await executeMessage(msg("tab"), d)).toBe("✅ 已发送 Tab");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("Tab", "proj-1");
  });

  it("clear/compact send the slash commands to the pane", async () => {
    const d = deps();
    expect(await executeMessage(msg("clear"), d)).toBe("✅ 已清空上下文 · /clear");
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/clear", "proj-1");
    expect(await executeMessage(msg("compact"), d)).toBe("✅ 已压缩上下文 · /compact");
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/compact", "proj-1");
  });

  it("status reflects whether Claude is running", async () => {
    expect(await executeMessage(msg("status"), deps())).toBe("🟢 Claude 运行中");
    expect(
      await executeMessage(msg("status"), deps({ checkIfRunning: vi.fn(async () => false) })),
    ).toBe("🔴 Claude 未运行");
  });

  it("text rejects (throws) when Claude isn't running — no keys sent", async () => {
    const d = deps({ checkIfRunning: vi.fn(async () => false) });
    await expect(executeMessage(msg("text", { text: "do it" }), d)).rejects.toThrow(
      "Claude 未运行",
    );
    expect(d.bridge.sendKeys).not.toHaveBeenCalled();
  });

  it("throws for an unknown action (isMessageAction returns false)", async () => {
    const bad = { ...msg("text"), action: "bogus-unknown" };
    await expect(
      executeMessage(bad as Parameters<typeof executeMessage>[0], deps()),
    ).rejects.toThrow("Unknown action");
  });
});

describe("executeMessage — text action with history", () => {
  let configRoot: string;
  beforeEach(() => {
    configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-dispatch-"));
  });
  afterEach(() => fs.rmSync(configRoot, { recursive: true, force: true }));

  it("sends the prompt then returns the matching assistant reply from history", async () => {
    const projectPath = "/proj/thing";
    setPathForSession("proj-1", projectPath); // so getPathBySession resolves the history dir
    const histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
    const line = (type: string, content: string) =>
      JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
    fs.writeFileSync(
      path.join(histDir, "a.jsonl"),
      `${[line("user", "build the feature now"), line("assistant", "feature built")].join("\n")}\n`,
    );

    const d = deps();
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const out = await executeMessage(msg("text", { text: "build the feature now" }), d);

    expect(d.bridge.sendKeys).toHaveBeenCalledWith("build the feature now", "proj-1");
    expect(out).toBe("feature built");
  });

  it("truncates an over-long history reply", async () => {
    const projectPath = "/proj/big";
    setPathForSession("proj-1", projectPath);
    const histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
    const long = "x".repeat(500);
    const line = (type: string, content: string) =>
      JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
    fs.writeFileSync(
      path.join(histDir, "a.jsonl"),
      `${[line("user", "make it long please"), line("assistant", long)].join("\n")}\n`,
    );
    const d = fakeDeps({
      claude: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => "P"),
      } as never,
      config: { maxMessageLength: 120 } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const out = await executeMessage(msg("text", { text: "make it long please" }), d);
    expect(out).toContain("...(内容过长，已截断)");
    expect(out.length).toBeLessThan(long.length);
  });

  it("falls back to the processed tmux pane when no history reply matches", async () => {
    // No history file → getLatestAssistantReply returns null → pane output is used.
    const d = fakeDeps({
      claude: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => "PANE_SNAPSHOT"),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const out = await executeMessage(msg("text", { text: "no matching prompt here xyz" }), d);
    expect(out).toBe("PANE_SNAPSHOT"); // output.process is identity in the fake
  });

  it("reports empty output when the pane processes to nothing", async () => {
    const d = fakeDeps({
      claude: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => "   "),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const out = await executeMessage(msg("text", { text: "another unmatched prompt abc" }), d);
    expect(out).toBe("Claude 返回空内容 · 用 /peek 查看画面");
  });

  it("falls back to capturePane when waitUntilDone throws", async () => {
    const d = fakeDeps({
      claude: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => {
          throw new Error("done failed");
        }),
      } as never,
      bridge: {
        capturePane: vi.fn(async () => "PANE_FALLBACK"),
        sendKeys: vi.fn(async () => {}),
        sendExit: vi.fn(async () => {}),
        sendRawKey: vi.fn(async () => {}),
        createSession: vi.fn(async () => {}),
        killSession: vi.fn(async () => {}),
        hasSession: vi.fn(async () => false),
        listProjectSessions: vi.fn(async () => []),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const out = await executeMessage(msg("text", { text: "fallback pane test xyz" }), d);
    expect(out).toBe("PANE_FALLBACK");
  });

  it("rethrows when both waitUntilDone and capturePane throw", async () => {
    const d = fakeDeps({
      claude: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => {
          throw new Error("done failed");
        }),
      } as never,
      bridge: {
        capturePane: vi.fn(async () => {
          throw new Error("pane failed");
        }),
        sendKeys: vi.fn(async () => {}),
        sendExit: vi.fn(async () => {}),
        sendRawKey: vi.fn(async () => {}),
        createSession: vi.fn(async () => {}),
        killSession: vi.fn(async () => {}),
        hasSession: vi.fn(async () => false),
        listProjectSessions: vi.fn(async () => []),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    await expect(executeMessage(msg("text", { text: "double fail xyz" }), d)).rejects.toThrow();
  });
});
