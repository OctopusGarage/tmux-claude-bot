import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotifierRegistry } from "../../../src/core/autopilot/notifier.js";
import type { HandlerDeps } from "../../../src/core/deps.js";
import { NotificationGateway } from "../../../src/core/notifications/gateway.js";
import { OwnerActivityTracker } from "../../../src/core/notifications/owner-activity.js";
import { ChannelSenderRegistry } from "../../../src/core/projects/channel-sender.js";

const sendMessage = vi.fn(async () => ({}));
const sendTelegramAttachment = vi.fn(async () => {});
const middlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void> | void> = [];

class FakeBot {
  api = {
    config: { use: vi.fn() },
    setMyCommands: vi.fn(async () => {}),
    getMe: vi.fn(async () => ({ id: 42, username: "test_bot" })),
    sendMessage,
  };
  use = vi.fn((middleware: (ctx: any, next: () => Promise<void>) => Promise<void> | void) => {
    middlewares.push(middleware);
  });
  catch = vi.fn();
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
}

class FakeInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [[]];

  text(text: string, callback_data: string): this {
    this.inline_keyboard.at(-1)?.push({ text, callback_data });
    return this;
  }

  row(): this {
    if ((this.inline_keyboard.at(-1)?.length ?? 0) > 0) this.inline_keyboard.push([]);
    return this;
  }
}

function mockGrammy(): void {
  vi.doMock("grammy", () => ({
    Bot: FakeBot,
    InlineKeyboard: FakeInlineKeyboard,
    GrammyError: class GrammyError extends Error {
      error_code: number;
      constructor(message = "grammy", error_code = 500) {
        super(message);
        this.error_code = error_code;
      }
    },
  }));
}

function deps(): HandlerDeps {
  return {
    config: {
      telegramBotToken: "token",
      telegramAllowedUserIds: new Set(["12345"]),
      telegramLongpollTimeoutSec: 1,
      telegramHttpProxy: undefined,
    },
    queue: {
      flushPending: vi.fn(),
    },
    notifier: new NotifierRegistry(),
    notifications: new NotificationGateway(),
    ownerActivity: new OwnerActivityTracker(),
    channelSenders: new ChannelSenderRegistry(),
  } as unknown as HandlerDeps;
}

describe("startTelegram notification registration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    middlewares.length = 0;
  });

  it("registers a telegram owner notification sender", async () => {
    mockGrammy();
    vi.doMock("@grammyjs/files", () => ({ hydrateFiles: vi.fn(() => vi.fn()) }));
    vi.doMock("../../../src/adapters/telegram/handlers.js", () => ({
      registerHandlers: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/voice-handler.js", () => ({
      registerVoiceHandler: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/media.js", () => ({ sendTelegramAttachment }));

    const { startTelegram } = await import("../../../src/adapters/telegram/start.js");
    const d = deps();
    const register = vi.spyOn(d.notifications, "register");
    const registerAttachment = vi.spyOn(d.notifications, "registerAttachment");

    await startTelegram(d);
    expect(register).toHaveBeenCalledWith("telegram", expect.any(Function));
    expect(registerAttachment).toHaveBeenCalledWith("telegram", expect.any(Function));

    const sender = register.mock.calls.find((c) => c[0] === "telegram")?.[1];
    await sender?.("hello from local project");

    expect(sendMessage).toHaveBeenCalledWith("12345", "hello from local project");

    const attachmentSender = registerAttachment.mock.calls.find((c) => c[0] === "telegram")?.[1];
    await attachmentSender?.("/tmp/report.html", "file", "Radar report");

    expect(sendTelegramAttachment).toHaveBeenCalledWith(
      expect.anything(),
      "12345",
      "/tmp/report.html",
      "file",
      "Radar report",
    );
  });

  it("routes batch owner notices through the notification gateway", async () => {
    mockGrammy();
    vi.doMock("@grammyjs/files", () => ({ hydrateFiles: vi.fn(() => vi.fn()) }));
    vi.doMock("../../../src/adapters/telegram/handlers.js", () => ({
      registerHandlers: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/voice-handler.js", () => ({
      registerVoiceHandler: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/media.js", () => ({ sendTelegramAttachment }));

    const { startTelegram } = await import("../../../src/adapters/telegram/start.js");
    const d = deps();
    const notify = vi.spyOn(d.notifications, "notify");

    await startTelegram(d);
    await d.notifier.broadcast({
      kind: "batchRunStarted",
      runId: "r1",
      planId: "plan-a",
      tasks: 2,
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        source: "batch-scheduler",
        title: "Batch scheduler",
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith("12345", expect.stringContaining("Batch scheduler"));
  });

  it("renders opportunity discovery notifications with telegram action buttons", async () => {
    mockGrammy();
    vi.doMock("@grammyjs/files", () => ({ hydrateFiles: vi.fn(() => vi.fn()) }));
    vi.doMock("../../../src/adapters/telegram/handlers.js", () => ({
      registerHandlers: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/voice-handler.js", () => ({
      registerVoiceHandler: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/media.js", () => ({ sendTelegramAttachment }));

    const { startTelegram } = await import("../../../src/adapters/telegram/start.js");
    const d = deps();
    const register = vi.spyOn(d.notifications, "register");

    await startTelegram(d);
    const sender = register.mock.calls.find((c) => c[0] === "telegram")?.[1];
    await sender?.("Opportunity suggestions: alcove", {
      title: "Opportunity suggestions: alcove",
      source: "opportunity-discovery",
      session: "tmux_proj_alcove",
      opportunities: [
        {
          id: "alcove-20260729-ad409ff3",
          title: "Add explain command",
          projectName: "alcove",
          category: "developer-experience",
          confidence: "high",
          estimatedComplexity: "small",
          status: "proposed",
          value: "Faster support.",
        },
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "12345",
      "Opportunity suggestions: alcove",
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ callback_data: "od:ad409ff3" }),
              expect.objectContaining({ callback_data: "ox:ad409ff3" }),
            ]),
          ]),
        }),
      }),
    );
  });

  it("runs the notification-ready callback after registering the sender", async () => {
    mockGrammy();
    vi.doMock("@grammyjs/files", () => ({ hydrateFiles: vi.fn(() => vi.fn()) }));
    vi.doMock("../../../src/adapters/telegram/handlers.js", () => ({
      registerHandlers: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/voice-handler.js", () => ({
      registerVoiceHandler: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/media.js", () => ({ sendTelegramAttachment }));

    const { startTelegram } = await import("../../../src/adapters/telegram/start.js");
    const d = deps();
    const onNotificationsReady = vi.fn(() => {
      expect(d.notifications.registeredChannels()).toEqual(["telegram"]);
    });

    await startTelegram(d, { onNotificationsReady });

    expect(onNotificationsReady).toHaveBeenCalledTimes(1);
  });

  it("records telegram as the recent owner activity channel for authorized updates", async () => {
    mockGrammy();
    vi.doMock("@grammyjs/files", () => ({ hydrateFiles: vi.fn(() => vi.fn()) }));
    vi.doMock("../../../src/adapters/telegram/handlers.js", () => ({
      registerHandlers: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/voice-handler.js", () => ({
      registerVoiceHandler: vi.fn(),
    }));
    vi.doMock("../../../src/adapters/telegram/media.js", () => ({ sendTelegramAttachment }));

    const { startTelegram } = await import("../../../src/adapters/telegram/start.js");
    const d = deps();
    const record = vi.spyOn(d.ownerActivity, "record");

    await startTelegram(d);
    await runMiddlewares({ from: { id: 12345 }, chat: { id: 100 } });

    expect(record).toHaveBeenCalledWith("telegram");
  });
});

async function runMiddlewares(ctx: any): Promise<void> {
  const dispatch = async (index: number): Promise<void> => {
    const middleware = middlewares[index];
    if (!middleware) return;
    await middleware(ctx, () => dispatch(index + 1));
  };
  await dispatch(0);
}
