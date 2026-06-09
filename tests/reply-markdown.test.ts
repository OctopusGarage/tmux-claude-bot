import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/shared/utils/error.js", () => ({
  normalizeError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

import type { Context } from "grammy";
import { reply } from "../src/adapters/telegram/replies.js";

function createMockContext(): Context {
  return {
    chat: { id: 12345 },
    message: { message_id: 999, date: 0, chat: { id: 12345, type: "private" } as never },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as unknown as Context;
}

describe("reply markdown (prose) mode", () => {
  beforeEach(() => vi.clearAllMocks());

  it("converts markdown prose to Telegram MarkdownV2", async () => {
    const ctx = createMockContext();
    await reply(ctx, "info", "", { body: "**done** in `1.2s`", markdown: true });
    const [text, extra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(text).toContain("*done*"); // MarkdownV2 bold (single asterisk)
    expect(text).toContain("`1.2s`");
    expect(text).not.toContain("**done**"); // raw double-asterisk is gone
    expect(extra.parse_mode).toBe("MarkdownV2");
  });

  it("sends plain text (no parse_mode) when neither code nor markdown is set", async () => {
    const ctx = createMockContext();
    await reply(ctx, "info", "", { body: "just text" });
    const [, extra] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(extra.parse_mode).toBeUndefined();
  });
});
