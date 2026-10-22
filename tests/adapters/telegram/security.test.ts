import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createRemoteAccessGuard } from "../../../src/adapters/telegram/security.js";
import type { RemoteAccessService } from "../../../src/core/security/remote-access.js";

describe("Telegram remote access guard", () => {
  it.each(["text", "voice", "callback"])(
    "blocks locked %s before downstream handlers",
    async (kind) => {
      const service = {
        capture: () => {
          throw new Error("locked");
        },
      } as unknown as RemoteAccessService;
      const reply = vi.fn(async () => {});
      const answerCallbackQuery = vi.fn(async () => {});
      const ctx = {
        from: { id: 123 },
        chat: { id: 123, type: "private" },
        reply,
        answerCallbackQuery,
        ...(kind === "text"
          ? { message: { text: "hello" } }
          : kind === "voice"
            ? { message: { voice: {} } }
            : { callbackQuery: { data: "a:enter:abc123" } }),
      } as unknown as Context;
      const next = vi.fn(async () => {});
      await createRemoteAccessGuard(service)(ctx, next);
      expect(next).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledOnce();
      if (kind === "callback") expect(answerCallbackQuery).toHaveBeenCalledOnce();
    },
  );

  it("retains unenrolled behavior", async () => {
    const service = { capture: () => undefined } as unknown as RemoteAccessService;
    const next = vi.fn(async () => {});
    await createRemoteAccessGuard(service)(
      { from: { id: 123 }, chat: { id: 123, type: "private" } } as Context,
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
