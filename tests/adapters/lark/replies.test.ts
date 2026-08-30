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

  it("retries a send_timeout (the SDK passes it through), then succeeds", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      // LarkChannelError shape: a `code` from the SDK's fixed vocabulary.
      vi.mocked(channel.send).mockRejectedValueOnce(
        Object.assign(new Error("send timed out"), { code: "send_timeout" }),
      );
      const p = sendText(channel, "chat-1", "hi");
      await vi.advanceTimersByTimeAsync(600); // backoff before the retry
      await p;
      expect(channel.send).toHaveBeenCalledTimes(2); // retried
      expect(channel.texts()).toContain("hi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hung channel.send and retries", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      vi.mocked(channel.send)
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce({ messageId: "m2" });

      const p = sendText(channel, "chat-1", "hi");
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(600);
      await p;

      expect(channel.send).toHaveBeenCalledTimes(2);
      expect(channel.send).toHaveBeenLastCalledWith("chat-1", { markdown: "hi" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry rate_limited (the SDK already retried+exhausted it)", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.send).mockRejectedValueOnce(
      Object.assign(new Error("rate limited"), { code: "rate_limited" }),
    );
    await sendText(channel, "chat-1", "hi");
    expect(channel.send).toHaveBeenCalledTimes(1); // no re-retry — would just hammer the limit
  });

  it("does NOT retry a permanent error (permission_denied)", async () => {
    const channel = fakeChannel();
    vi.mocked(channel.send).mockRejectedValueOnce(
      Object.assign(new Error("no permission"), { code: "permission_denied" }),
    );
    await sendText(channel, "chat-1", "hi");
    expect(channel.send).toHaveBeenCalledTimes(1); // permanent — fail fast
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
