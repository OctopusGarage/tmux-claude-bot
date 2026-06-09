import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { safeAnswerCallback } from "../src/adapters/telegram/callback-utils.js";

describe("safeAnswerCallback", () => {
  it("answers with a toast text when provided", async () => {
    const ctx = { answerCallbackQuery: vi.fn().mockResolvedValue(true) };
    await safeAnswerCallback(ctx, "✅ 已切换");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "✅ 已切换" });
  });

  it("answers with no payload when no text is given (just stops the spinner)", async () => {
    const ctx = { answerCallbackQuery: vi.fn().mockResolvedValue(true) };
    await safeAnswerCallback(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(undefined);
  });

  it("swallows network errors so a failed answer never crashes the bot", async () => {
    const ctx = {
      answerCallbackQuery: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    };
    await expect(safeAnswerCallback(ctx, "x")).resolves.toBeUndefined();
  });
});
