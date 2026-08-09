import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDeps } from "../lark/_fakes.js";

// Mock only the output side-effects; let the routing logic run for real.
vi.mock("../../../src/adapters/telegram/replies.js", () => ({ reply: vi.fn(), send: vi.fn() }));
vi.mock("../../../src/adapters/telegram/prompt-lifecycle.js", () => ({
  runPromptWithProgress: vi.fn(),
}));
vi.mock("../../../src/adapters/telegram/views.js", () => ({
  sendAliveList: vi.fn(),
  sendHistory: vi.fn(),
  sendPeek: vi.fn(),
  sendInputs: vi.fn(),
  sendQueueStatus: vi.fn(),
  sendBrowse: vi.fn(),
  sendStatusInstall: vi.fn(),
  sendRecoverPreview: vi.fn(),
  replyCreateProject: vi.fn(),
}));
vi.mock("../../../src/adapters/telegram/callbacks.js", () => ({ handleCallbackQuery: vi.fn() }));
vi.mock("../../../src/adapters/telegram/executor.js", () => ({
  handleQueuedCommand: vi.fn(),
}));
vi.mock("../../../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { handleQueuedCommand } from "../../../src/adapters/telegram/executor.js";
import { registerHandlers } from "../../../src/adapters/telegram/handlers.js";
import { runPromptWithProgress } from "../../../src/adapters/telegram/prompt-lifecycle.js";
import { reply } from "../../../src/adapters/telegram/replies.js";
import {
  sendAliveList,
  sendBrowse,
  sendHistory,
  sendInputs,
  sendPeek,
  sendQueueStatus,
  sendRecoverPreview,
  sendStatusInstall,
} from "../../../src/adapters/telegram/views.js";
import {
  clearBrowse,
  requestNewFolder,
  startBrowse,
} from "../../../src/core/projects/dir-browser.js";
import { requestFreeLabel } from "../../../src/core/projects/free-label-prompt.js";
import { chatScope } from "../../../src/core/projects/project-manager.js";

const replyMock = reply as ReturnType<typeof vi.fn>;
const promptMock = runPromptWithProgress as ReturnType<typeof vi.fn>;
const sendBrowseMock = sendBrowse as ReturnType<typeof vi.fn>;
const sendPeekMock = sendPeek as ReturnType<typeof vi.fn>;
const sendInputsMock = sendInputs as ReturnType<typeof vi.fn>;
const sendHistoryMock = sendHistory as ReturnType<typeof vi.fn>;
const sendAliveListMock = sendAliveList as ReturnType<typeof vi.fn>;
const sendQueueStatusMock = sendQueueStatus as ReturnType<typeof vi.fn>;
const sendRecoverPreviewMock = sendRecoverPreview as ReturnType<typeof vi.fn>;
const sendStatusInstallMock = sendStatusInstall as ReturnType<typeof vi.fn>;
const handleQueuedMock = handleQueuedCommand as ReturnType<typeof vi.fn>;

// A bot that captures the registered command/event handlers so we can drive them.
function captureBot() {
  const handlers: Record<string, (ctx: unknown) => unknown> = {};
  const bot = {
    command: (name: string, h: (ctx: unknown) => unknown) => {
      handlers[`cmd:${name}`] = h;
    },
    on: (event: string, h: (ctx: unknown) => unknown) => {
      handlers[`on:${event}`] = h;
    },
  };
  return { bot, handlers };
}

function depsFor(over = {}) {
  return fakeDeps({
    queue: { loadPersisted: vi.fn(() => []), clearPersisted: vi.fn() },
    config: { maxInboundLength: 100, projectSessionPrefix: "tmux_proj_", cdAllowedDirs: [] },
    ...over,
  } as never);
}

const replyTarget = {
  record: vi.fn(),
  resolve: vi.fn((): string | null => null),
  removeSession: vi.fn(),
};

function ctx(text: string, over: Record<string, unknown> = {}) {
  return {
    message: { text, message_id: 7, reply_to_message: undefined, ...(over.message ?? {}) },
    chat: { id: 100, ...(over.chat ?? {}) },
  };
}

async function runText(deps: ReturnType<typeof depsFor>, c: unknown) {
  const { bot, handlers } = captureBot();
  registerHandlers(bot as any, deps, replyTarget as never);
  await handlers["on:message:text"]?.(c);
}

function runCmd(name: string, text: string, deps: ReturnType<typeof depsFor>) {
  const { bot, handlers } = captureBot();
  registerHandlers(bot as any, deps, replyTarget as never);
  return handlers[`cmd:${name}`]?.(ctx(text));
}

function runCmdWithCtx(name: string, c: unknown, deps: ReturnType<typeof depsFor>) {
  const { bot, handlers } = captureBot();
  registerHandlers(bot as any, deps, replyTarget as never);
  return handlers[`cmd:${name}`]?.(c);
}

describe("registerHandlers — /start flavor picker", () => {
  beforeEach(() => replyMock.mockClear());

  it("shows the picker when multiple start commands are configured", async () => {
    const deps = depsFor({
      config: {
        startCommands: [
          { label: "claude-stella", command: "claude-stella" },
          { label: "claude-yolo", command: "claude-yolo" },
        ],
      },
      currentProject: { get: vi.fn(async () => "tmux_proj_x") },
      agent: { checkIfRunning: vi.fn(async () => false) }, // not running → picker, not "already running"
    });
    await runCmd("start", "/start", deps);
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
  });

  it("rejects /start with 'already running' (no picker) when an agent is live", async () => {
    const deps = depsFor({
      config: {
        startCommands: [
          { label: "claude-stella", command: "claude-stella" },
          { label: "claude-yolo", command: "claude-yolo" },
        ],
      },
      currentProject: { get: vi.fn(async () => "tmux_proj_x") },
      agent: { checkIfRunning: vi.fn(async () => true) }, // already running
    });
    await runCmd("start", "/start", deps);
    // no picker (info + replyMarkup) — an "already running" reply instead
    expect(replyMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "ok",
      expect.any(String),
      expect.anything(),
    );
  });

  it("does not show the picker when only one start command is configured", async () => {
    const deps = depsFor({
      config: { startCommands: [{ label: "claude", command: "bash" }] },
      currentProject: { get: vi.fn(async () => "tmux_proj_x") },
    });
    await runCmd("start", "/start", deps);
    expect(replyMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
  });

  it("/restart also shows the picker when multiple commands are configured", async () => {
    const deps = depsFor({
      config: {
        startCommands: [
          { label: "claude-stella", command: "claude-stella" },
          { label: "claude-yolo", command: "claude-yolo" },
        ],
      },
      currentProject: { get: vi.fn(async () => "tmux_proj_x") },
    });
    await runCmd("restart", "/restart", deps);
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
  });
});

describe("registerHandlers — /ws command", () => {
  let stateDir: string;
  let origEnv: string | undefined;

  beforeEach(() => {
    replyMock.mockClear();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-ws-tg-"));
    origEnv = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = stateDir;
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = origEnv;
  });

  it("/ws list with no workspaces replies empty list", async () => {
    await runCmd("ws", "/ws list", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "list", expect.any(String));
  });

  it("/ws save with no name replies usage", async () => {
    await runCmd("ws", "/ws save", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws save with invalid name replies invalid-name", async () => {
    await runCmd("ws", "/ws save inv@lid!", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws save with no current project replies no-current-project", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runCmd("ws", "/ws save my-proj", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws save with valid name and active session saves and replies ok", async () => {
    await runCmd("ws", "/ws save my-proj", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "ok", expect.anything());
  });

  it("/ws use with no name replies usage", async () => {
    await runCmd("ws", "/ws use", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws use with unknown name replies not-found", async () => {
    await runCmd("ws", "/ws use ghost", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws use with saved name but dead session replies session-gone", async () => {
    // Save the workspace first, then run /ws use with hasSession returning false.
    await runCmd("ws", "/ws save my-proj", depsFor());
    const deps = depsFor({ bridge: { hasSession: vi.fn(async () => false) } });
    await runCmd("ws", "/ws use my-proj", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws use with saved name and live session switches and replies ok", async () => {
    await runCmd("ws", "/ws save my-proj", depsFor());
    const deps = depsFor({ bridge: { hasSession: vi.fn(async () => true) } });
    await runCmd("ws", "/ws use my-proj", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "ok", expect.anything());
  });

  it("/ws remove with no name replies usage", async () => {
    await runCmd("ws", "/ws remove", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws remove with unknown name replies not-found", async () => {
    await runCmd("ws", "/ws remove ghost", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.anything());
  });

  it("/ws remove with saved name removes and replies ok", async () => {
    await runCmd("ws", "/ws save my-proj", depsFor());
    await runCmd("ws", "/ws remove my-proj", depsFor());
    expect(replyMock).toHaveBeenLastCalledWith(expect.anything(), "ok", expect.anything());
  });

  it("/ws with unknown subcommand replies usage", async () => {
    await runCmd("ws", "/ws bogus", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "info", expect.anything());
  });

  it("/ws list with saved workspaces replies the list", async () => {
    await runCmd("ws", "/ws save proj-a", depsFor());
    replyMock.mockClear();
    await runCmd("ws", "/ws list", depsFor());
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "list",
      expect.stringContaining("proj-a"),
    );
  });
});

describe("registerHandlers — message:text routing", () => {
  beforeEach(() => {
    replyMock.mockClear();
    promptMock.mockClear();
    replyTarget.record.mockClear();
    replyTarget.resolve.mockReturnValue(null);
  });

  it("rejects an over-long message", async () => {
    await runText(depsFor(), ctx("x".repeat(101)));
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.stringContaining("消息过长"),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("replies no-session when there's no current project and no reply target", async () => {
    await runText(depsFor({ currentProject: { get: vi.fn(async () => undefined) } }), ctx("hello"));
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.stringContaining("没有活跃会话"),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("replies not-running when Claude is down for the session", async () => {
    const deps = depsFor({ agent: { checkIfRunning: vi.fn(async () => false) } });
    await runText(deps, ctx("do a thing"));
    expect(replyTarget.record).toHaveBeenCalledWith(7, "proj-1");
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.stringContaining("未运行"),
      // idle-adaptive: the not-running reply now carries a start/projects keyboard
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("runs the prompt when Claude is running for the current session", async () => {
    const deps = depsFor({ agent: { checkIfRunning: vi.fn(async () => true) } });
    const c = ctx("build me a thing");
    await runText(deps, c);
    expect(promptMock).toHaveBeenCalledWith(c, deps, "proj-1", "build me a thing", replyTarget);
  });

  it("routes a reply-to-message to that message's session", async () => {
    replyTarget.resolve.mockReturnValue("proj-reply");
    const deps = depsFor({ agent: { checkIfRunning: vi.fn(async () => true) } });
    const c = ctx("follow up", { message: { message_id: 9, reply_to_message: { message_id: 5 } } });
    await runText(deps, c);
    expect(replyTarget.resolve).toHaveBeenCalledWith(5);
    expect(promptMock).toHaveBeenCalledWith(c, deps, "proj-reply", "follow up", replyTarget);
  });

  it("takes a text reply during a new-folder prompt as the folder name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-tg-nf-"));
    const scope = chatScope("telegram", "100");
    try {
      startBrowse(scope, [dir]); // single root → cwd = dir
      requestNewFolder(scope); // arm the capture
      const deps = depsFor({
        config: { maxInboundLength: 100, projectSessionPrefix: "tmux_proj_", cdAllowedDirs: [dir] },
      });
      await runText(deps, ctx("fresh"));
      // The folder was created and the browser re-opened (not routed to Claude).
      expect(fs.existsSync(path.join(dir, "fresh"))).toBe(true);
      expect(sendBrowseMock).toHaveBeenCalled();
      expect(promptMock).not.toHaveBeenCalled();
    } finally {
      clearBrowse(scope);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites a still-queued ack in place when replying to it (terminal)", async () => {
    const deps = depsFor({
      queue: {
        loadPersisted: vi.fn(() => []),
        clearPersisted: vi.fn(),
        rewriteByAck: vi.fn(() => ({ kind: "rewritten", session: "proj-rw" }) as never),
      },
      agent: { checkIfRunning: vi.fn(async () => true) },
    });
    const c = ctx("new text", { message: { message_id: 9, reply_to_message: { message_id: 5 } } });
    await runText(deps, c);
    // Rewrite is terminal: the prompt is NOT re-enqueued as a fresh message.
    expect(promptMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "ok",
      expect.any(String),
      expect.objectContaining({ session: "proj-rw" }),
    );
  });

  it("reports a dedup-blocked rewrite (warn) instead of re-enqueueing", async () => {
    const deps = depsFor({
      queue: {
        loadPersisted: vi.fn(() => []),
        clearPersisted: vi.fn(),
        rewriteByAck: vi.fn(() => ({ kind: "duplicate", session: "proj-rw" }) as never),
      },
      agent: { checkIfRunning: vi.fn(async () => true) },
    });
    const c = ctx("dupe", { message: { message_id: 9, reply_to_message: { message_id: 5 } } });
    await runText(deps, c);
    expect(promptMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "warn",
      expect.any(String),
      expect.anything(),
    );
  });

  it("reports a failed queued-ack rewrite without re-enqueueing the prompt", async () => {
    const deps = depsFor({
      queue: {
        loadPersisted: vi.fn(() => []),
        clearPersisted: vi.fn(),
        rewriteByAck: vi.fn(() => ({ kind: "failed" }) as never),
      },
      agent: { checkIfRunning: vi.fn(async () => true) },
    });
    const c = ctx("new text", { message: { message_id: 9, reply_to_message: { message_id: 5 } } });

    await runText(deps, c);

    expect(promptMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.any(String),
      expect.objectContaining({ replyTarget }),
    );
  });

  it("consumes an awaited independent-session label and creates an independent session", async () => {
    const scope = chatScope("telegram", "100");
    requestFreeLabel(scope); // arm the label capture for this chat
    const deps = depsFor({
      bridge: { listProjectSessions: vi.fn(async () => []) },
    });
    await runText(deps, ctx("my-label"));
    // The label was consumed (not routed to Claude as a prompt).
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/switch_<id> with no matching alive session replies no-short-id", async () => {
    // listProjectSessions is empty in the default fake → no short id resolves.
    const deps = depsFor({ bridge: { listProjectSessions: vi.fn(async () => []) } });
    await runText(deps, ctx("/switch_abc123"));
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.any(String),
      expect.anything(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/remove_<id> with no matching alive session replies no-short-id", async () => {
    const deps = depsFor({ bridge: { listProjectSessions: vi.fn(async () => []) } });
    await runText(deps, ctx("/remove_abc123"));
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.any(String),
      expect.anything(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/remove_<id> removes the matching alive session and clears reply targets", async () => {
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const session = "tmux_proj_remove_me";
    const deps = depsFor({
      bridge: {
        listProjectSessions: vi.fn(async () => [session]),
        killSession: vi.fn(async () => undefined),
      },
      currentProject: {
        get: vi.fn(async () => session),
        clearSession: vi.fn(async () => undefined),
      },
    });

    await runText(deps, ctx(`/remove_${sessionShortId(session)}`));

    expect(replyTarget.removeSession).toHaveBeenCalledWith(session);
    expect(deps.currentProject.clearSession).toHaveBeenCalledWith(session);
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "ok",
      expect.any(String),
      expect.anything(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("/switch_<id> switches to the matching alive session and replies ok", async () => {
    // Build a session whose short id we can derive, and make it "alive".
    const { sessionShortId } = await import("../../../src/shared/utils/hash.js");
    const session = "tmux_proj_alive";
    const deps = depsFor({
      bridge: { listProjectSessions: vi.fn(async () => [session]) },
    });
    await runText(deps, ctx(`/switch_${sessionShortId(session)}`));
    expect(deps.currentProject.set).toHaveBeenCalledWith(expect.any(String), session);
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "ok",
      expect.any(String),
      expect.objectContaining({ session }),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });
});

describe("registerHandlers — commands routed to mocked views/executor", () => {
  beforeEach(() => {
    replyMock.mockClear();
    promptMock.mockClear();
    handleQueuedMock.mockClear();
    sendPeekMock.mockClear();
    sendInputsMock.mockClear();
    sendHistoryMock.mockClear();
    sendAliveListMock.mockClear();
    sendQueueStatusMock.mockClear();
    sendRecoverPreviewMock.mockClear();
    sendStatusInstallMock.mockClear();
    sendBrowseMock.mockClear();
    replyTarget.resolve.mockReturnValue(null);
  });

  it("/help renders the help body", async () => {
    await runCmd("help", "/help", depsFor());
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "help", expect.any(String));
  });

  it("/lang with no arg shows the current language + keyboard", async () => {
    await runCmd("lang", "/lang", depsFor());
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
  });

  it("/lang with an invalid code replies usage", async () => {
    await runCmd("lang", "/lang klingon", depsFor());
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.stringContaining("Usage"),
      expect.anything(),
    );
  });

  it("/lang with a valid code (case-insensitive) sets it", async () => {
    await runCmd("lang", "/lang ZH", depsFor());
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.anything(),
    );
  });

  it("/prompt_translate with no arg shows the translation picker + keyboard", async () => {
    await runCmd("prompt_translate", "/prompt_translate", depsFor());
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
  });

  // resolveSessionFromReply gates on bridge.hasSession + isPaneAlive (the lark
  // fake omits isPaneAlive), so the live-session paths supply an alive bridge.
  const aliveBridge = {
    bridge: {
      hasSession: vi.fn(async () => true),
      isPaneAlive: vi.fn(async () => true),
    },
  };

  it("/peek with a live session pages the pane via sendPeek", async () => {
    await runCmd("peek", "/peek 50", depsFor(aliveBridge));
    expect(sendPeekMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "proj-1",
      replyTarget,
      expect.any(Number),
    );
  });

  it("/peek with no resolvable session replies no-session", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runCmd("peek", "/peek", deps);
    expect(sendPeekMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });

  it("/inputs with a live session lists recent inputs via sendInputs", async () => {
    await runCmd("inputs", "/inputs 5", depsFor(aliveBridge));
    expect(sendInputsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "proj-1",
      replyTarget,
      expect.any(Number),
    );
  });

  it("/inputs with no session replies no-session", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runCmd("inputs", "/inputs", deps);
    expect(sendInputsMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });

  it("/history with a live session renders history via sendHistory", async () => {
    await runCmd("history", "/history 2", depsFor(aliveBridge));
    // arg "2" → index 1 (zero-based)
    expect(sendHistoryMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "proj-1",
      1,
      replyTarget,
    );
  });

  it("/history with no session replies no-session", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runCmd("history", "/history", deps);
    expect(sendHistoryMock).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });

  it("/list_alive_projects delegates to sendAliveList", async () => {
    await runCmd("list_alive_projects", "/list_alive_projects", depsFor());
    expect(sendAliveListMock).toHaveBeenCalled();
  });

  it("/queue_status delegates to sendQueueStatus", async () => {
    await runCmd("queue_status", "/queue_status", depsFor());
    expect(sendQueueStatusMock).toHaveBeenCalled();
  });

  it("/recover delegates to sendRecoverPreview", async () => {
    await runCmd("recover", "/recover", depsFor());
    expect(sendRecoverPreviewMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      replyTarget,
    );
  });

  it("/status_install delegates to sendStatusInstall in scan mode", async () => {
    await runCmd("status_install", "/status_install", depsFor());
    expect(sendStatusInstallMock).toHaveBeenCalledWith(expect.anything(), "scan", replyTarget);
  });

  it("/add_project with no arg opens the directory browser", async () => {
    await runCmd("add_project", "/add_project", depsFor());
    expect(sendBrowseMock).toHaveBeenCalled();
  });

  it("/current_project with no current project replies error", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runCmd("current_project", "/current_project", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });

  it("/current_project with a live current project lists it", async () => {
    const deps = depsFor({
      currentProject: { get: vi.fn(async () => "proj-1") },
      bridge: { hasSession: vi.fn(async () => true) },
    });
    await runCmd("current_project", "/current_project", deps);
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "list",
      expect.any(String),
      expect.objectContaining({ session: "proj-1", body: expect.any(String) }),
    );
  });

  it("/current_project includes free-project and agent metadata", async () => {
    const deps = depsFor({
      currentProject: { get: vi.fn(async () => "tmux_proj_free_2") },
      bridge: { hasSession: vi.fn(async () => true) },
      configResolver: { detectAgentKind: vi.fn(async () => "codex" as const) },
    });
    await runCmd("current_project", "/current_project", deps);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "list",
      expect.any(String),
      expect.objectContaining({
        session: "tmux_proj_free_2",
        body: expect.stringContaining("类型：独立会话"),
      }),
    );
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "list",
      expect.any(String),
      expect.objectContaining({
        session: "tmux_proj_free_2",
        body: expect.stringContaining("Agent：Codex"),
      }),
    );
  });

  it("/home ignores non-private chats before changing the current project", async () => {
    const deps = depsFor({
      currentProject: { set: vi.fn() },
      config: {
        projectSessionPrefix: "tmux_proj_",
        homeOperator: { enabled: true, agent: "codex", dir: "/repo/operator" },
      },
    });

    await runCmdWithCtx("home", ctx("/home", { chat: { id: 100, type: "group" } }), deps);

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("/home reports disabled home operator in private chats", async () => {
    const deps = depsFor({
      currentProject: { set: vi.fn() },
      config: {
        projectSessionPrefix: "tmux_proj_",
        homeOperator: { enabled: false, agent: "codex", dir: "/repo/operator" },
      },
    });

    await runCmdWithCtx("home", ctx("/home", { chat: { id: 100, type: "private" } }), deps);

    expect(deps.currentProject.set).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "view",
      expect.any(String),
      expect.objectContaining({ replyTarget }),
    );
  });

  it("/prompts ignores non-private chats and reports disabled prompt library in private chats", async () => {
    await runCmdWithCtx(
      "prompts",
      ctx("/prompts", { chat: { id: 100, type: "group" } }),
      depsFor(),
    );
    expect(replyMock).not.toHaveBeenCalled();

    await runCmdWithCtx(
      "prompts",
      ctx("/prompts", { chat: { id: 100, type: "private" } }),
      depsFor({ config: { promptMcp: { command: "" } } }),
    );

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      expect.any(String),
      expect.objectContaining({ replyTarget }),
    );
  });

  it("/sessions with no current project replies no-session", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runCmd("sessions", "/sessions", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });

  it("/sessions with a current project but no path mapping replies no-path-mapping", async () => {
    // getPathBySession returns undefined for an unknown session → no-path branch.
    const deps = depsFor({ currentProject: { get: vi.fn(async () => "proj-unmapped") } });
    await runCmd("sessions", "/sessions", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });

  it("/list_recent_projects with no recents replies the empty list", async () => {
    const deps = depsFor({ bridge: { listProjectSessions: vi.fn(async () => []) } });
    await runCmd("list_recent_projects", "/list_recent_projects", deps);
    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "list", expect.any(String));
  });

  it("/list_recent_projects includes project status details in the message body", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-recent-status-"));
    const sessionName = `tmux_proj_${dir.replace(/\//g, "-")}`;
    const { setPathForSession } = await import("../../../src/core/projects/sessionPathMap.js");
    setPathForSession(sessionName, dir);
    const deps = depsFor({
      bridge: { listProjectSessions: vi.fn(async () => [sessionName]) },
      configResolver: { detectAgentKind: vi.fn(async () => "codex" as const) },
    });

    await runCmd("list_recent_projects", "/list_recent_projects", deps);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "list",
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining("会话：运行中"),
      }),
    );
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "list",
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining("Agent：Codex"),
      }),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a queued action (e.g. /status) routes to handleQueuedCommand", async () => {
    await runCmd("status", "/status", depsFor());
    expect(handleQueuedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "status",
      undefined,
      replyTarget,
    );
  });
});
