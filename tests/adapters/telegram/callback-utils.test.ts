import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeAnswerCallback } from "../../../src/adapters/telegram/callback-utils.js";

const fakeCtx = () => ({
  answerCallbackQuery: vi.fn(async () => undefined),
});

describe("safeAnswerCallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers with text when provided", async () => {
    const ctx = fakeCtx();
    await safeAnswerCallback(ctx, "ok");
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "ok" });
  });

  it("answers with undefined when no text", async () => {
    const ctx = fakeCtx();
    await safeAnswerCallback(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(undefined);
  });

  it("swallows Error thrown by answerCallbackQuery", async () => {
    const ctx = fakeCtx();
    ctx.answerCallbackQuery.mockRejectedValueOnce(new Error("query too old"));
    await expect(safeAnswerCallback(ctx, "hi")).resolves.toBeUndefined();
  });

  it("swallows non-Error thrown by answerCallbackQuery", async () => {
    const ctx = fakeCtx();
    ctx.answerCallbackQuery.mockRejectedValueOnce("raw error");
    await expect(safeAnswerCallback(ctx)).resolves.toBeUndefined();
  });
});
