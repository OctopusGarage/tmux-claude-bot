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
  sendQueueStatus: vi.fn(),
}));
vi.mock("../../../src/adapters/telegram/callbacks.js", () => ({ handleCallbackQuery: vi.fn() }));
vi.mock("../../../src/adapters/telegram/executor.js", () => ({
  handleQueuedCommand: vi.fn(),
  createRestoredMessage: vi.fn(),
}));
vi.mock("../../../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerHandlers } from "../../../src/adapters/telegram/handlers.js";
import { runPromptWithProgress } from "../../../src/adapters/telegram/prompt-lifecycle.js";
import { reply } from "../../../src/adapters/telegram/replies.js";

const replyMock = reply as ReturnType<typeof vi.fn>;
const promptMock = runPromptWithProgress as ReturnType<typeof vi.fn>;

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
  resolveReplyTarget: vi.fn((): string | null => null),
  removeSession: vi.fn(),
};

function ctx(text: string, over: Record<string, unknown> = {}) {
  return {
    message: { text, message_id: 7, reply_to_message: undefined, ...(over.message ?? {}) },
    chat: { id: 100 },
  };
}

async function runText(deps: ReturnType<typeof depsFor>, c: unknown) {
  const { bot, handlers } = captureBot();
  // biome-ignore lint/suspicious/noExplicitAny: test bot shim
  registerHandlers(bot as any, deps, replyTarget as never);
  await handlers["on:message:text"]?.(c);
}

function runCmd(name: string, text: string, deps: ReturnType<typeof depsFor>) {
  const { bot, handlers } = captureBot();
  // biome-ignore lint/suspicious/noExplicitAny: test bot shim
  registerHandlers(bot as any, deps, replyTarget as never);
  return handlers[`cmd:${name}`]?.(ctx(text));
}

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
    replyTarget.resolveReplyTarget.mockReturnValue(null);
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
    const deps = depsFor({ claude: { checkIfRunning: vi.fn(async () => false) } });
    await runText(deps, ctx("do a thing"));
    expect(replyTarget.record).toHaveBeenCalledWith(7, "proj-1");
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      expect.stringContaining("未运行"),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("runs the prompt when Claude is running for the current session", async () => {
    const deps = depsFor({ claude: { checkIfRunning: vi.fn(async () => true) } });
    const c = ctx("build me a thing");
    await runText(deps, c);
    expect(promptMock).toHaveBeenCalledWith(c, deps, "proj-1", "build me a thing", replyTarget);
  });

  it("routes a reply-to-message to that message's session", async () => {
    replyTarget.resolveReplyTarget.mockReturnValue("proj-reply");
    const deps = depsFor({ claude: { checkIfRunning: vi.fn(async () => true) } });
    const c = ctx("follow up", { message: { message_id: 9, reply_to_message: { message_id: 5 } } });
    await runText(deps, c);
    expect(replyTarget.resolveReplyTarget).toHaveBeenCalledWith(5);
    expect(promptMock).toHaveBeenCalledWith(c, deps, "proj-reply", "follow up", replyTarget);
  });
});
