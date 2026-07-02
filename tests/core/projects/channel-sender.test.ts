import { describe, expect, it, vi } from "vitest";
import { ChannelSenderRegistry } from "../../../src/core/projects/channel-sender.js";

describe("ChannelSenderRegistry", () => {
  it("routes a send to the registered channel only", async () => {
    const r = new ChannelSenderRegistry();
    const tg = vi.fn(async () => {});
    const lark = vi.fn(async () => {});
    r.register("telegram", tg);
    r.register("lark", lark);
    await r.send("telegram", "123", "/a.png", "image", "cap");
    expect(tg).toHaveBeenCalledWith("123", "/a.png", "image", "cap");
    expect(lark).not.toHaveBeenCalled();
  });

  it("throws when no sender is registered for the channel", async () => {
    const r = new ChannelSenderRegistry();
    await expect(r.send("lark", "oc_x", "/a.pdf", "file")).rejects.toThrow(
      "no sender registered for lark",
    );
  });
});
