import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendCard, sendText } from "../../../src/adapters/lark/replies.js";
import { fakeChannel } from "./_fakes.js";

describe("sendText", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends markdown to the channel on success", async () => {
    const channel = fakeChannel();
    await sendText(channel, "chat-1", "hello");
    expect(channel.texts()).toContain("hello");
  });

  it("swallows Error instances thrown by channel.send", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.send).mockRejectedValueOnce(new Error("network down"));
    await expect(sendText(channel, "chat-1", "hi")).resolves.toBeUndefined();
  });

  it("swallows non-Error throws from channel.send", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.send).mockRejectedValueOnce("plain string error");
    await expect(sendText(channel, "chat-1", "hi")).resolves.toBeUndefined();
  });
});

describe("sendCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the message id on success", async () => {
    const channel = fakeChannel();
    const id = await sendCard(channel, "chat-1", { type: "card" });
    expect(id).toBe("m1");
  });

  it("returns undefined and swallows Error thrown by channel.send", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.send).mockRejectedValueOnce(new Error("send failed"));
    const id = await sendCard(channel, "chat-1", {});
    expect(id).toBeUndefined();
  });

  it("returns undefined and swallows non-Error thrown by channel.send", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.send).mockRejectedValueOnce(42);
    const id = await sendCard(channel, "chat-1", {});
    expect(id).toBeUndefined();
  });
});
