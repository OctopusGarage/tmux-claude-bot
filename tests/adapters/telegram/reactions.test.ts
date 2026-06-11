import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactToMessage } from "../../../src/adapters/telegram/reactions.js";

const fakeApi = () => ({
  setMessageReaction: vi.fn(async () => undefined),
});

describe("reactToMessage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls setMessageReaction with the emoji", async () => {
    const api = fakeApi();
    await reactToMessage(api, 1, 2, "👍");
    expect(api.setMessageReaction).toHaveBeenCalledWith(1, 2, [{ type: "emoji", emoji: "👍" }]);
  });

  it("swallows Error thrown by setMessageReaction", async () => {
    const api = fakeApi();
    api.setMessageReaction.mockRejectedValueOnce(new Error("emoji not supported"));
    await expect(reactToMessage(api, 1, 2, "👍")).resolves.toBeUndefined();
  });

  it("swallows non-Error thrown by setMessageReaction", async () => {
    const api = fakeApi();
    api.setMessageReaction.mockRejectedValueOnce("plain rejection");
    await expect(reactToMessage(api, 1, 2, "👍")).resolves.toBeUndefined();
  });
});
