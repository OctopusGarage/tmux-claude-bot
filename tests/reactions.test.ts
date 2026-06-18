import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { REACTION, reactToMessage } from "../src/adapters/telegram/reactions.js";

describe("reactToMessage", () => {
  it("sets an emoji reaction in Telegram's expected shape", async () => {
    const api = { setMessageReaction: vi.fn().mockResolvedValue(undefined) };
    await reactToMessage(api, 12345, 999, REACTION.received);
    expect(api.setMessageReaction).toHaveBeenCalledWith(12345, 999, [
      { type: "emoji", emoji: REACTION.received },
    ]);
  });

  it("swallows API errors so a failed reaction never breaks the flow", async () => {
    const api = { setMessageReaction: vi.fn().mockRejectedValue(new Error("REACTION_INVALID")) };
    await expect(reactToMessage(api, 1, 2, REACTION.done)).resolves.toBeUndefined();
  });

  it("exposes distinct emojis for received / done / failed states", () => {
    expect(new Set([REACTION.received, REACTION.done, REACTION.failed]).size).toBe(3);
  });
});
