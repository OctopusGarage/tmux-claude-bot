import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentKind } from "../src/core/agents/agentKindMap.js";
import { projectPathToHistoryDir } from "../src/core/agents/claude/claude-history.js";
import type { MessageAction } from "../src/core/command/actions.js";
import {
  assertClaudeBinaryAccessible,
  executeMessage,
  performRestart,
  performStart,
} from "../src/core/command/dispatch.js";
import type { QueuedMessage } from "../src/core/command/queue.js";
import { setPathForSession } from "../src/core/projects/sessionPathMap.js";
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
    agent: {
      checkIfRunning: vi.fn(async () => true),
      waitUntilReady: vi.fn(async () => {}),
      waitUntilInputReady: vi.fn(async () => {}),
      waitUntilDone: vi.fn(async () => ({ done: true, output: "PANE" })),
      start: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      exit: vi.fn(async () => {}),
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

  it("skips empty PATH segments and still finds a named binary in a real dir", () => {
    // PATH with an empty leading segment ("") and an empty middle segment exercises
    // the `if (!dir) continue` guard; "sh" then resolves in /bin.
    const orig = process.env.PATH;
    process.env.PATH = ":/nonexistent::/bin:";
    try {
      expect(() => assertClaudeBinaryAccessible("sh")).not.toThrow();
    } finally {
      process.env.PATH = orig;
    }
  });

  it("still rejects an unknown binary when PATH is unset", () => {
    const orig = process.env.PATH;
    delete process.env.PATH;
    try {
      expect(() => assertClaudeBinaryAccessible("__no_such_binary_xyz_1234__")).toThrow(
        /not found in PATH/,
      );
    } finally {
      process.env.PATH = orig;
    }
  });

  // A launcher defined only as a shell alias/function (e.g. `claude-stella` in
  // ~/.zshrc) is not on PATH, but the command runs in the session's interactive
  // shell via tmux send-keys — so the pre-flight must accept it. HOME is pointed
  // at a temp dir whose rc files we control (os.homedir() honours $HOME on POSIX).
  function withRcFiles(files: Record<string, string>, fn: () => void) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(tmp, name), body);
    const origHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      fn();
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("accepts a name defined as a shell alias in ~/.zshrc (not on PATH)", () => {
    withRcFiles({ ".zshrc": 'alias claude-stella="CLAUDE_CONFIG_DIR=~/.x claude --foo"\n' }, () => {
      expect(() => assertClaudeBinaryAccessible("claude-stella")).not.toThrow();
    });
  });

  it("accepts a name defined as a shell alias in ~/.zsh_aliases (not on PATH)", () => {
    withRcFiles(
      { ".zsh_aliases": 'alias claude-dernan="CLAUDE_CONFIG_DIR=~/.x claude --foo"\n' },
      () => {
        expect(() => assertClaudeBinaryAccessible("claude-dernan")).not.toThrow();
      },
    );
  });

  it("accepts a name defined as a shell function in ~/.bashrc", () => {
    withRcFiles({ ".bashrc": 'my-launcher() {\n  claude "$@"\n}\n' }, () => {
      expect(() => assertClaudeBinaryAccessible("my-launcher")).not.toThrow();
    });
  });

  it("accepts a binary resolved by the user's interactive shell PATH", () => {
    const origHome = process.env.HOME;
    const origPath = process.env.PATH;
    const origShell = process.env.SHELL;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "interactive-path-"));
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "codex-test-bin"), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(binDir, "codex-test-bin"), 0o755);
    fs.writeFileSync(path.join(tmp, ".bash_profile"), 'export PATH="$HOME/bin:$PATH"\n');
    process.env.HOME = tmp;
    process.env.PATH = "/usr/bin:/bin";
    process.env.SHELL = "/bin/bash";
    try {
      expect(() => assertClaudeBinaryAccessible("codex-test-bin --yolo")).not.toThrow();
    } finally {
      process.env.HOME = origHome;
      process.env.PATH = origPath;
      process.env.SHELL = origShell;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("waits long enough for a slow interactive shell to resolve a launcher", () => {
    const origHome = process.env.HOME;
    const origPath = process.env.PATH;
    const origShell = process.env.SHELL;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slow-shell-"));
    const shell = path.join(tmp, "shell");
    fs.writeFileSync(shell, "#!/bin/sh\nsleep 1\nexit 0\n");
    fs.chmodSync(shell, 0o755);
    process.env.HOME = tmp;
    process.env.PATH = "/usr/bin:/bin";
    process.env.SHELL = shell;
    try {
      expect(() => assertClaudeBinaryAccessible("slow-shell-launcher")).not.toThrow();
    } finally {
      process.env.HOME = origHome;
      process.env.PATH = origPath;
      process.env.SHELL = origShell;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still throws when a name is neither on PATH nor defined in any rc file", () => {
    withRcFiles({ ".zshrc": 'alias other="claude"\n' }, () => {
      expect(() => assertClaudeBinaryAccessible("__no_such_launcher_xyz__")).toThrow(
        /not found in PATH/,
      );
    });
  });
});

describe("performRestart", () => {
  it("asserts the binary, restarts with --continue, and invalidates the config cache", async () => {
    const d = deps();
    await performRestart(d, "proj-1");
    expect(d.agent.gracefulRestartWithContinue).toHaveBeenCalledWith("proj-1", undefined);
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("proj-1");
  });

  it("passes a command override through to the restart and asserts THAT binary", async () => {
    const d = deps();
    // "sh" is a valid bin so assertClaudeBinaryAccessible(command) passes.
    await performRestart(d, "proj-1", "sh --flavor");
    expect(d.agent.gracefulRestartWithContinue).toHaveBeenCalledWith("proj-1", "sh --flavor");
  });

  it("throws (and does not restart) when the override command's binary is missing", async () => {
    const d = deps();
    await expect(performRestart(d, "proj-1", "/no/such/bin/ever --x")).rejects.toThrow(
      /not found or not executable/,
    );
    expect(d.agent.gracefulRestartWithContinue).not.toHaveBeenCalled();
  });
});

describe("executeMessage — control actions", () => {
  it("no session → done", async () => {
    expect(await executeMessage(msg("status", { sessionName: undefined }), deps())).toBe("完成");
  });

  it("start launches Claude with a bot-assigned --session-id and invalidates config", async () => {
    const d = deps({ checkIfRunning: vi.fn(async () => false) }); // not running → start proceeds
    expect(await executeMessage(msg("start"), d)).toBe("✅ 已启动");
    // Claude gets a bot-pinned session id appended to the primary command, so the
    // exact conversation id is owned deterministically (for /restart + recovery).
    expect(d.agent.start).toHaveBeenCalledWith(
      "proj-1",
      expect.stringMatching(/^bash --session-id [0-9a-f-]{36}$/),
    );
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("proj-1");
  });

  it("start persists the kind, exact command, and the assigned session id (for recovery)", async () => {
    const d = deps({ checkIfRunning: vi.fn(async () => false) }); // not running → start proceeds
    await executeMessage(msg("start"), d);
    const { getAgentKind } = await import("../src/core/agents/agentKindMap.js");
    const { getStartCommand } = await import("../src/core/agents/startCommandMap.js");
    const { getLastLiveSessionId } = await import("../src/core/agents/live-session-id.js");
    expect(getAgentKind("proj-1")).toBe("claude");
    expect(getStartCommand("proj-1")).toBe("bash"); // the base flavor, no --session-id
    expect(getLastLiveSessionId("proj-1")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("exit clears the queue, exits the agent via the runner, invalidates config", async () => {
    const d = deps();
    expect(await executeMessage(msg("exit"), d)).toBe("✅ 已退出");
    expect(d.queue.clearSession).toHaveBeenCalledWith("proj-1");
    // Routed through the agent runner (both agents: Ctrl-C + /exit), not the
    // hardcoded bridge.sendExit it used to call.
    expect(d.agent.exit).toHaveBeenCalledWith("proj-1");
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("proj-1");
  });

  it("restart does a graceful --continue restart", async () => {
    const d = deps();
    expect(await executeMessage(msg("restart"), d)).toBe("🔄 已重启");
    expect(d.agent.gracefulRestartWithContinue).toHaveBeenCalledWith("proj-1");
  });

  it("esc interrupts; interrupt sends Ctrl-C; enter/up/down/tab send raw keys", async () => {
    const d = deps();
    expect(await executeMessage(msg("esc"), d)).toBe("✅ 已发送 Esc");
    expect(d.agent.interrupt).toHaveBeenCalledWith("proj-1");
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

  it("interrupt/esc/raw-keys are tolerant — they go through even when no agent is running", async () => {
    // Escape hatches: a stuck/uncertain pane must still accept Ctrl-C and raw keys.
    const d = deps({ checkIfRunning: vi.fn(async () => false) });
    expect(await executeMessage(msg("interrupt"), d)).toBe("✅ 已中断 · Ctrl-C");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("C-c", "proj-1");
    expect(await executeMessage(msg("enter"), d)).toBe("✅ 已回车");
    expect(await executeMessage(msg("esc"), d)).toBe("✅ 已发送 Esc");
  });

  it("clear/compact send the slash commands and invalidate the resolver cache", async () => {
    const d = deps();
    expect(await executeMessage(msg("clear"), d)).toBe("✅ 已清空上下文 · /clear");
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/clear", "proj-1");
    // /clear starts a new session → new transcript; the cached open-transcript
    // must be dropped so the next read re-detects it.
    expect(d.configResolver.invalidate).toHaveBeenCalledWith("proj-1");
    expect(await executeMessage(msg("compact"), d)).toBe("✅ 已压缩上下文 · /compact");
    expect(d.bridge.sendKeys).toHaveBeenCalledWith("/compact", "proj-1");
  });

  it("left/right send the raw arrow keys", async () => {
    const d = deps();
    expect(await executeMessage(msg("left"), d)).toBe("✅ 已发送 ←");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("Left", "proj-1");
    expect(await executeMessage(msg("right"), d)).toBe("✅ 已发送 →");
    expect(d.bridge.sendRawKey).toHaveBeenCalledWith("Right", "proj-1");
  });

  it("defaults to the telegram catalog when msg.channel is undefined", async () => {
    // channel undefined → `msg.channel ?? "telegram"` → zh telegram strings.
    const d = deps();
    const out = await executeMessage(msg("status", { channel: undefined }), d);
    expect(out).toContain("🟢 Claude 运行中"); // statusRunning("Claude") → "🟢 Claude 运行中"
  });

  it("status reflects whether Claude is running", async () => {
    // /status leads with the running state (usage figures append when configured).
    expect(await executeMessage(msg("status"), deps())).toContain("🟢 Claude 运行中");
    expect(
      await executeMessage(msg("status"), deps({ checkIfRunning: vi.fn(async () => false) })),
    ).toContain("🔴 Claude 未运行");
  });

  it("start is rejected when an agent is already running (no second agent)", async () => {
    const d = deps({ checkIfRunning: vi.fn(async () => true) }); // already running
    expect(await executeMessage(msg("start"), d)).toBe("✅ 已在运行中，无需重复启动");
    expect(d.agent.start).not.toHaveBeenCalled();
  });

  it("a running-required action is rejected when Claude isn't running — no keys sent", async () => {
    const d = deps({ checkIfRunning: vi.fn(async () => false) });
    expect(await executeMessage(msg("text", { text: "do it" }), d)).toBe(
      "未运行，请使用 /restart 启动",
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

  it("sends the delivered prompt and matches history against it", async () => {
    const projectPath = "/proj/translated";
    setPathForSession("proj-1", projectPath);
    const histDir = projectPathToHistoryDir(projectPath, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
    const line = (type: string, content: string) =>
      JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
    fs.writeFileSync(
      path.join(histDir, "a.jsonl"),
      `${[line("user", "Ship the feature now"), line("assistant", "feature shipped")].join("\n")}\n`,
    );

    const d = deps();
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const out = await executeMessage(
      msg("text", {
        text: "Ship the feature now",
        origin: "user",
        promptSource: "telegram",
        sourceText: "把功能做完",
        transform: {
          kind: "translation",
          provider: "argos",
          from: "zh",
          to: "en",
          sourceText: "把功能做完",
          deliveredText: "Ship the feature now",
        },
      }),
      d,
    );

    expect(d.bridge.sendKeys).toHaveBeenCalledWith("Ship the feature now", "proj-1");
    expect(out).toBe("feature shipped");
  });

  it("does not translate a system text action", async () => {
    const fakePython = path.join(configRoot, "fake-python");
    fs.writeFileSync(fakePython, "#!/bin/sh\ncat >/dev/null\nprintf 'Continue in English'\n");
    fs.chmodSync(fakePython, 0o755);
    const oldEnv = {
      mode: process.env.PROMPT_TRANSLATE_MODE,
      python: process.env.ARGOS_TRANSLATE_PYTHON,
    };
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    process.env.ARGOS_TRANSLATE_PYTHON = fakePython;

    try {
      const d = deps();

      await executeMessage(msg("text", { text: "继续", origin: "system" }), d);

      expect(d.bridge.sendKeys).toHaveBeenCalledWith("继续", "proj-1");
    } finally {
      process.env.PROMPT_TRANSLATE_MODE = oldEnv.mode;
      process.env.ARGOS_TRANSLATE_PYTHON = oldEnv.python;
    }
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
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => ({ done: true, output: "P" })),
      } as never,
      config: { maxMessageLength: 120 } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const out = await executeMessage(msg("text", { text: "make it long please" }), d);
    expect(out).toContain("...(内容过长，已截断)");
    expect(out.length).toBeLessThan(long.length);
  });

  it("uses the session name as the history key when no path is mapped (getPathBySession fallback)", async () => {
    // A session with no setPathForSession entry → getPathBySession returns
    // undefined → `?? session` uses the raw session name to derive the history dir.
    // The transcript is stored under that derived dir so the reply still resolves.
    const unmappedSession = "unmapped-session-xyz";
    const histDir = projectPathToHistoryDir(unmappedSession, configRoot);
    fs.mkdirSync(histDir, { recursive: true });
    const line = (type: string, content: string) =>
      JSON.stringify({ type, timestamp: "2026-06-10T10:00:00Z", message: { content } });
    fs.writeFileSync(
      path.join(histDir, "a.jsonl"),
      `${[line("user", "fallback keyed prompt"), line("assistant", "fallback keyed reply")].join("\n")}\n`,
    );
    const d = deps();
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const out = await executeMessage(
      msg("text", { sessionName: unmappedSession, text: "fallback keyed prompt" }),
      d,
    );
    expect(out).toBe("fallback keyed reply");
  });

  it("handles a text action with undefined text (length defaults to 0, no history match)", async () => {
    // msg.text undefined exercises `msg.text?.length ?? 0` in the entry log and a
    // null sent-text lookup; falls back to the pane snapshot.
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => ({ done: true, output: "PANE_FOR_UNDEF" })),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const noText = msg("text");
    delete (noText as { text?: string }).text;
    const out = await executeMessage(noText, d);
    expect(out).toBe("PANE_FOR_UNDEF");
  });

  it("falls back to the processed tmux pane when no history reply matches", async () => {
    // No history file → getLatestAssistantReply returns null → pane output is used.
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => ({ done: true, output: "PANE_SNAPSHOT" })),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const out = await executeMessage(msg("text", { text: "no matching prompt here xyz" }), d);
    expect(out).toBe("PANE_SNAPSHOT"); // output.process is identity in the fake
  });

  it("reports empty output when the pane processes to nothing", async () => {
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => ({ done: true, output: "   " })),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);
    const out = await executeMessage(msg("text", { text: "another unmatched prompt abc" }), d);
    expect(out).toBe("返回空内容 · 用 /peek 查看画面");
  });

  it("waits for the agent input surface before sending text", async () => {
    const calls: string[] = [];
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilInputReady: vi.fn(async () => {
          calls.push("ready");
        }),
        waitUntilDone: vi.fn(async () => {
          calls.push("done");
          return { done: true, output: "PANE" };
        }),
      } as never,
      bridge: {
        sendKeys: vi.fn(async () => {
          calls.push("send");
        }),
      } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    await executeMessage(msg("text", { text: "build the feature" }), d);

    expect(calls).toEqual(["ready", "send", "done"]);
    expect(d.agent.waitUntilInputReady).toHaveBeenCalledWith("proj-1");
  });

  it("keeps waiting across timeout rounds and notifies once, then resolves the real result", async () => {
    const waitUntilDone = vi
      .fn()
      .mockResolvedValueOnce({ done: false, output: "partial 1" })
      .mockResolvedValueOnce({ done: false, output: "partial 2" })
      .mockResolvedValueOnce({ done: true, output: "FINAL" });
    const d = fakeDeps({
      agent: { checkIfRunning: vi.fn(async () => true), waitUntilDone } as never,
      config: { maxWaitDoneMs: 100, maxWaitDoneTotalMs: 1000 } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const notices: string[] = [];
    const out = await executeMessage(
      msg("text", { text: "long task xyz", notify: (t) => notices.push(t) }),
      d,
    );

    expect(out).toBe("FINAL");
    expect(waitUntilDone).toHaveBeenCalledTimes(3);
    expect(notices).toHaveLength(1); // one notice at the first timeout, not one per round
    expect(notices[0]).toContain("任务仍在进行中");
  });

  it("gives up at the total-wait horizon with the still-running reply", async () => {
    const waitUntilDone = vi.fn(async () => ({ done: false, output: "PARTIAL" }));
    const d = fakeDeps({
      agent: { checkIfRunning: vi.fn(async () => true), waitUntilDone } as never,
      config: { maxWaitDoneMs: 100, maxWaitDoneTotalMs: 250 } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const out = await executeMessage(msg("text", { text: "endless task xyz" }), d);

    // 100ms per round → cumulative wait hits 100/200/300ms; 300 ≥ 250 stops it.
    expect(waitUntilDone).toHaveBeenCalledTimes(3);
    expect(out).toContain("任务仍在进行中");
    expect(out).toContain("PARTIAL");
  });

  it("a timeout without a notify channel still keeps waiting (no crash)", async () => {
    const waitUntilDone = vi
      .fn()
      .mockResolvedValueOnce({ done: false, output: "partial" })
      .mockResolvedValueOnce({ done: true, output: "DONE_LATE" });
    const d = fakeDeps({
      agent: { checkIfRunning: vi.fn(async () => true), waitUntilDone } as never,
      config: { maxWaitDoneMs: 100, maxWaitDoneTotalMs: 1000 } as never,
    });
    (d.configResolver.resolveConfigRoot as ReturnType<typeof vi.fn>).mockResolvedValue(configRoot);

    const out = await executeMessage(msg("text", { text: "quiet long task xyz" }), d);
    expect(out).toBe("DONE_LATE");
  });

  it("falls back to capturePane when waitUntilDone throws", async () => {
    const d = fakeDeps({
      agent: {
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

  it("falls back to capturePane when waitUntilDone throws a non-Error value", async () => {
    // Throwing a string (not an Error) exercises the `: err` branch of the
    // error-logging ternary; capturePane still salvages the pane.
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => {
          throw "string failure";
        }),
      } as never,
      bridge: {
        capturePane: vi.fn(async () => "PANE_AFTER_STRING_THROW"),
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
    const out = await executeMessage(msg("text", { text: "non error throw xyz" }), d);
    expect(out).toBe("PANE_AFTER_STRING_THROW");
  });

  it("rethrows a normalized error when both waitUntilDone and capturePane throw non-Errors", async () => {
    // Both throws are non-Error literals → hits the `: err` and `: paneErr`
    // branches of both logging ternaries before normalizeError rethrows.
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilDone: vi.fn(async () => {
          throw "wait literal";
        }),
      } as never,
      bridge: {
        capturePane: vi.fn(async () => {
          throw "pane literal";
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
    await expect(
      executeMessage(msg("text", { text: "double literal fail xyz" }), d),
    ).rejects.toThrow();
  });

  it("rethrows when both waitUntilDone and capturePane throw", async () => {
    const d = fakeDeps({
      agent: {
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

describe("performStart / performRestart — agent kind recording", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-dispatch-agent-"));
    process.env.TCB_STATE_DIR = stateDir;
  });
  afterEach(() => {
    delete process.env.TCB_STATE_DIR;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("performStart records 'codex' when the command matches a codex startCommand", async () => {
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => false),
        start: vi.fn(async () => {}),
      } as never,
      config: {
        claudeStartCommand: "bash",
        startCommands: [
          { label: "claude", command: "bash", agent: "claude" as const },
          { label: "codex", command: "sh", agent: "codex" as const },
        ],
      } as never,
    });
    await performStart(d, "proj-codex", "sh");
    expect(await getAgentKind("proj-codex")).toBe("codex");
  });

  it("performStart records 'claude' for the default (no command)", async () => {
    const d = fakeDeps({
      agent: {
        checkIfRunning: vi.fn(async () => false),
        start: vi.fn(async () => {}),
      } as never,
    });
    await performStart(d, "proj-claude");
    expect(await getAgentKind("proj-claude")).toBe("claude");
  });

  it("performRestart records 'codex' when the command matches a codex startCommand", async () => {
    const d = fakeDeps({
      agent: {
        gracefulRestartWithContinue: vi.fn(async () => {}),
      } as never,
      config: {
        claudeStartCommand: "bash",
        startCommands: [
          { label: "claude", command: "bash", agent: "claude" as const },
          { label: "codex", command: "sh", agent: "codex" as const },
        ],
      } as never,
    });
    await performRestart(d, "proj-codex-restart", "sh");
    expect(await getAgentKind("proj-codex-restart")).toBe("codex");
  });

  it("performRestart records 'claude' when no command override (default)", async () => {
    const d = fakeDeps({
      agent: {
        gracefulRestartWithContinue: vi.fn(async () => {}),
      } as never,
    });
    await performRestart(d, "proj-claude-restart");
    expect(await getAgentKind("proj-claude-restart")).toBe("claude");
  });
});
