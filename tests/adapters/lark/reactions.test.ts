import { beforeEach, describe, expect, it, vi } from "vitest";
import { markDone, markWorking } from "../../../src/adapters/lark/reactions.js";
import { fakeChannel } from "./_fakes.js";

describe("markWorking", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds the OnIt reaction on success", async () => {
    const channel = fakeChannel();
    await markWorking(channel, "msg-1");
    expect(channel.reactions).toEqual([{ messageId: "msg-1", emoji: "OnIt" }]);
  });

  it("swallows Error thrown by addReaction", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.addReaction).mockRejectedValueOnce(new Error("api error"));
    await expect(markWorking(channel, "msg-1")).resolves.toBeUndefined();
  });

  it("swallows non-Error thrown by addReaction", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.addReaction).mockRejectedValueOnce("string error");
    await expect(markWorking(channel, "msg-1")).resolves.toBeUndefined();
  });
});

describe("markDone", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes OnIt and adds DONE on success", async () => {
    const channel = fakeChannel();
    await markDone(channel, "msg-1");
    expect(channel.removedReactions).toEqual([{ messageId: "msg-1", emoji: "OnIt" }]);
    expect(channel.reactions).toEqual([{ messageId: "msg-1", emoji: "DONE" }]);
  });

  it("continues to add DONE even when removeReactionByEmoji throws", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.removeReactionByEmoji).mockRejectedValueOnce(new Error("gone"));
    await markDone(channel, "msg-1");
    expect(channel.reactions).toEqual([{ messageId: "msg-1", emoji: "DONE" }]);
  });

  it("swallows Error thrown by addReaction on DONE", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.addReaction).mockRejectedValueOnce(new Error("emoji blocked"));
    await expect(markDone(channel, "msg-1")).resolves.toBeUndefined();
  });

  it("swallows non-Error thrown by addReaction on DONE", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.addReaction).mockRejectedValueOnce("raw rejection");
    await expect(markDone(channel, "msg-1")).resolves.toBeUndefined();
  });
});
