import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// log-query resolves LOG_DIR from TCB_LOG_DIR at module load — set before import.
const logDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-logs-tg-"));
process.env.TCB_LOG_DIR = logDir;

const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
const mkRec = (o: Record<string, unknown>): string =>
  JSON.stringify({ ts: now.toISOString(), level: "INFO", msg: "x", ...o });

fs.writeFileSync(
  nodePath.join(logDir, `tcb-${stamp}.jsonl`),
  `${[
    mkRec({ level: "WARN", component: "cmp", msg: "careful-now", session: "tmux_proj_x" }),
    mkRec({ level: "ERROR", component: "cmp", msg: "boom-here", session: "tmux_proj_x" }),
    mkRec({ level: "INFO", component: "cmp", msg: "noisy-info", session: "tmux_proj_x" }),
    mkRec({ level: "ERROR", component: "cmp", msg: "traced-only", traceId: "t_abc" }),
  ].join("\n")}\n`,
  "utf-8",
);

// Mock the output side-effects; let the /logs routing run for real.
vi.mock("../../../src/adapters/telegram/replies.js", () => ({ reply: vi.fn(), send: vi.fn() }));
vi.mock("../../../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

const { registerHandlers } = await import("../../../src/adapters/telegram/handlers.js");
const { reply } = await import("../../../src/adapters/telegram/replies.js");
const { fakeDeps } = await import("./_fakes.js");

const replyMock = reply as ReturnType<typeof vi.fn>;

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

const replyTarget = {
  record: vi.fn(),
  resolve: vi.fn((): string | null => null),
  removeSession: vi.fn(),
};

function depsFor(over = {}) {
  return fakeDeps({
    queue: { loadPersisted: vi.fn(() => []), clearPersisted: vi.fn() },
    ...over,
  } as never);
}

function runLogs(text: string, deps: ReturnType<typeof depsFor>) {
  const { bot, handlers } = captureBot();
  registerHandlers(bot as never, deps, replyTarget as never);
  return handlers["cmd:logs"]?.({ message: { text, message_id: 7 }, chat: { id: 100 } });
}

describe("/logs (Telegram)", () => {
  beforeEach(() => replyMock.mockClear());

  afterAll(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
    delete process.env.TCB_LOG_DIR;
  });

  it("renders recent WARN/ERROR for the current session as a code block", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => "tmux_proj_x") } });
    await runLogs("/logs", deps);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "view",
      expect.any(String),
      expect.objectContaining({ code: true, body: expect.stringContaining("boom-here") }),
    );
    const body = replyMock.mock.calls.at(-1)?.[3]?.body as string;
    expect(body).toContain("careful-now");
    expect(body).not.toContain("noisy-info"); // WARN+ only
  });

  it("with a t_ trace arg filters to that trace (session-independent)", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runLogs("/logs t_abc", deps);

    const body = replyMock.mock.calls.at(-1)?.[3]?.body as string;
    expect(body).toContain("traced-only");
  });

  it("with no current project and no trace replies the friendly hint", async () => {
    const deps = depsFor({ currentProject: { get: vi.fn(async () => null) } });
    await runLogs("/logs", deps);

    expect(replyMock).toHaveBeenCalledWith(expect.anything(), "err", expect.any(String));
  });
});
