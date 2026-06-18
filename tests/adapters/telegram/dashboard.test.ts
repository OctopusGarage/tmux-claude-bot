import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the output side-effects; let the /dashboard routing run for real.
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
  resolveReplyTarget: vi.fn((): string | null => null),
  removeSession: vi.fn(),
};

function depsFor(over = {}) {
  return fakeDeps({
    queue: { loadPersisted: vi.fn(() => []), clearPersisted: vi.fn(), size: vi.fn(() => 0) },
    bridge: {
      listProjectSessions: vi.fn(async () => [] as string[]),
      sessionsCreatedAt: vi.fn(async () => new Map<string, number>()),
    },
    ...over,
  } as never);
}

function runDashboard(deps: ReturnType<typeof depsFor>) {
  const { bot, handlers } = captureBot();
  registerHandlers(bot as never, deps, replyTarget as never);
  return handlers["cmd:dashboard"]?.({
    message: { text: "/dashboard", message_id: 7 },
    chat: { id: 100 },
  });
}

describe("/dashboard (Telegram)", () => {
  beforeEach(() => replyMock.mockClear());

  it("renders the global header as a code block", async () => {
    const deps = depsFor();
    await runDashboard(deps);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "view",
      expect.any(String),
      expect.objectContaining({
        code: true,
        body: expect.stringContaining("tmux-claude-bot"),
      }),
    );
    const body = replyMock.mock.calls.at(-1)?.[3]?.body as string;
    expect(body).toContain("sessions");
  });
});
