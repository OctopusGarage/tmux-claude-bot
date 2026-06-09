import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger before importing replies (vi.mock is hoisted)
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock normalizeError
vi.mock("../src/utils/error.js", () => ({
  normalizeError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

import type { Bot, Context } from "grammy";
import { reply, send, type Tone } from "../src/bot/replies.js";
import { logger } from "../src/utils/logger.js";

function createMockContext(overrides: Partial<Context> = {}): Context {
  return {
    chat: { id: 12345 },
    message: { message_id: 999, date: 0, chat: { id: 12345, type: "private" } as any },
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Context;
}

function createMockBot(): Bot {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Bot;
}

describe("compose (via reply/send integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a status line plus a friendly project line when session is provided", async () => {
    const ctx = createMockContext();
    await reply(ctx, "ok", "完成", { session: "tmux_proj_-Users-test-project" });
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(text).toContain("✅ 完成");
    expect(text).toContain("📂 "); // friendly project line (no path mapped → #shortid)
    expect(text).not.toContain("[tmux_proj_"); // the long ugly tag is gone
  });

  it("omits the project line when no session provided", async () => {
    const ctx = createMockContext();
    await reply(ctx, "ok", "完成");
    expect(ctx.reply).toHaveBeenCalledWith("✅ 完成", expect.any(Object));
  });

  it("appends elapsed time to the status line when elapsedS is set", async () => {
    const ctx = createMockContext();
    await reply(ctx, "result", "完成", { elapsedS: 12 });
    const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(text).toContain("🤖 完成 · ⏱ 12s");
  });

  it("formats terminal output as a MarkdownV2 code block", async () => {
    const ctx = createMockContext();
    await reply(ctx, "info", "", { body: "console.log(1)", code: true });
    const [text, extra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(extra.parse_mode).toBe("MarkdownV2");
    expect(text).toContain("```\nconsole.log(1)\n```");
    expect(extra).toHaveProperty("reply_to_message_id");
  });

  it("uses correct emoji for each tone", async () => {
    const ctx = createMockContext();
    const tones: { tone: Tone; expected: string }[] = [
      { tone: "ok", expected: "✅" },
      { tone: "err", expected: "❌" },
      { tone: "warn", expected: "⚠️" },
      { tone: "queue", expected: "📋" },
      { tone: "queued", expected: "⏳" },
      { tone: "list", expected: "📁" },
      { tone: "view", expected: "👁" },
      { tone: "recover", expected: "🔄" },
      { tone: "info", expected: "" },
      { tone: "help", expected: "" },
    ];

    for (const { tone, expected } of tones) {
      vi.clearAllMocks();
      await reply(ctx, tone, "test");
      const [text] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
      if (expected) {
        expect(text).toContain(expected);
      }
      expect(text).toContain("test");
    }
  });
});

describe("reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults reply_to_message_id to ctx.message.message_id", async () => {
    const ctx = createMockContext({ message: { message_id: 42 } as any });
    await reply(ctx, "ok", "test");
    const [, extra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(extra.reply_to_message_id).toBe(42);
  });

  it("uses opts.replyTo when explicitly provided", async () => {
    const ctx = createMockContext({ message: { message_id: 42 } as any });
    await reply(ctx, "ok", "test", { replyTo: 100 });
    const [, extra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(extra.reply_to_message_id).toBe(100);
  });

  it("does not add reply_to_message_id when ctx.message is undefined", async () => {
    const ctx = createMockContext({ message: undefined });
    await reply(ctx, "ok", "test");
    const [, extra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(extra).not.toHaveProperty("reply_to_message_id");
  });

  it("retries on ECONNRESET network error", async () => {
    const ctx = createMockContext();
    const networkError = {
      error_code: undefined,
      error: { code: "ECONNRESET", message: "connection reset" },
    };
    (ctx.reply as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(undefined);

    await reply(ctx, "ok", "test");
    expect(ctx.reply).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("network error on attempt 1/3"),
    );
  });

  it("retries on error_code 429 (rate limit)", async () => {
    const ctx = createMockContext();
    const rateLimitError = { error_code: 429, description: "Too Many Requests" };
    (ctx.reply as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(undefined);

    await reply(ctx, "ok", "test");
    expect(ctx.reply).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-retryable errors", async () => {
    const ctx = createMockContext();
    const fatalError = { error_code: 403, description: "Forbidden" };
    (ctx.reply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(fatalError);

    await reply(ctx, "ok", "test");
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("falls back to plain text when Markdown parse fails", async () => {
    const ctx = createMockContext();
    const parseError = {
      error_code: 400,
      description: "can't parse entities",
    };
    (ctx.reply as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(parseError)
      .mockResolvedValueOnce(undefined);

    await reply(ctx, "info", "", { body: "test", code: true });
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    const [, secondExtra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1] ?? [];
    expect(secondExtra.parse_mode).toBeUndefined();
  });

  it("logs error when both Markdown and fallback fail", async () => {
    const ctx = createMockContext();
    const parseError = {
      error_code: 400,
      description: "can't parse entities",
    };
    (ctx.reply as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(parseError)
      .mockRejectedValueOnce(new Error("fallback failed"));

    await reply(ctx, "info", "", { body: "test", code: true });
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("fallback reply failed"));
  });

  it("gives up after 3 retry attempts on network errors", async () => {
    const ctx = createMockContext();
    const networkError = {
      error: { code: "ETIMEDOUT", message: "timed out" },
    };
    (ctx.reply as ReturnType<typeof vi.fn>).mockRejectedValue(networkError);

    await reply(ctx, "ok", "test");
    expect(ctx.reply).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("reply failed"));
  });
});

describe("send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends message via bot.api.sendMessage", async () => {
    const bot = createMockBot();
    await send(bot, 12345, "ok", "hello");
    expect(bot.api.sendMessage).toHaveBeenCalledWith(12345, "✅ hello", expect.any(Object));
  });

  it("includes reply_to_message_id when replyTo is provided", async () => {
    const bot = createMockBot();
    await send(bot, 12345, "ok", "hello", { replyTo: 77 });
    const [, , extra] = (bot.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(extra.reply_to_message_id).toBe(77);
  });

  it("retries on ECONNRESET", async () => {
    const bot = createMockBot();
    const networkError = {
      error: { code: "ECONNRESET", message: "connection reset" },
    };
    (bot.api.sendMessage as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(undefined);

    await send(bot, 12345, "ok", "hello");
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
