import { describe, expect, it, vi } from "vitest";
import { handleSendAttachment } from "../../../src/adapters/control/server.js";
import { ChannelSenderRegistry } from "../../../src/core/projects/channel-sender.js";

vi.mock("../../../src/core/projects/session-reply-target.js", () => ({
  resolveReplyTarget: vi.fn(),
}));

import { resolveReplyTarget } from "../../../src/core/projects/session-reply-target.js";

function depsWith(reg: ChannelSenderRegistry) {
  return { channelSenders: reg } as unknown as Parameters<typeof handleSendAttachment>[0];
}

describe("handleSendAttachment", () => {
  it("fails when no chat is bound", async () => {
    vi.mocked(resolveReplyTarget).mockReturnValue(null);
    const res = await handleSendAttachment(depsWith(new ChannelSenderRegistry()), {
      session: "s1",
      filePath: "/a.png",
      statInfo: () => ({ size: 10, isFile: true }),
    });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("no chat is bound") });
  });

  it("fails when the file is missing", async () => {
    vi.mocked(resolveReplyTarget).mockReturnValue({ channel: "telegram", chatId: "1" });
    const res = await handleSendAttachment(depsWith(new ChannelSenderRegistry()), {
      session: "s1",
      filePath: "/missing.png",
      statInfo: () => null,
    });
    expect(res.ok).toBe(false);
  });

  it("dispatches a valid image to the resolved channel", async () => {
    vi.mocked(resolveReplyTarget).mockReturnValue({ channel: "telegram", chatId: "55" });
    const reg = new ChannelSenderRegistry();
    const tg = vi.fn(async () => {});
    reg.register("telegram", tg);
    const res = await handleSendAttachment(depsWith(reg), {
      session: "s1",
      filePath: "/diagram.png",
      caption: "arch",
      statInfo: () => ({ size: 100, isFile: true }),
    });
    expect(res).toEqual({ ok: true, status: "sent" });
    expect(tg).toHaveBeenCalledWith("55", "/diagram.png", "image", "arch");
  });

  it("returns ok:false when the sender throws", async () => {
    vi.mocked(resolveReplyTarget).mockReturnValue({ channel: "telegram", chatId: "1" });
    const reg = new ChannelSenderRegistry();
    reg.register("telegram", vi.fn().mockRejectedValue(new Error("network fail")));
    const res = await handleSendAttachment(depsWith(reg), {
      session: "s1",
      filePath: "/a.png",
      statInfo: () => ({ size: 10, isFile: true }),
    });
    expect(res).toEqual({ ok: false, error: "network fail" });
  });
});
