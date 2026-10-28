import { describe, expect, it, vi } from "vitest";
import { secureLarkMessage } from "../../../src/adapters/lark/security.js";
import type { RemoteAccessService } from "../../../src/core/security/remote-access.js";
import { fakeChannel, fakeDeps, fakeMessage } from "./_fakes.js";

describe("Lark remote access guard", () => {
  it.each(["p2p", "group"] as const)(
    "sends a standalone copyable approval command privately after %s unlock",
    async (chatType) => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      deps.remoteAccess = {
        request: () => ({ id: "approval-request", expiresAt: Date.now() + 300_000 }),
        status: () => ({ grantTtlSeconds: 86400 }),
      } as unknown as RemoteAccessService;
      const run = vi.fn(async () => {});
      await secureLarkMessage(channel, deps, run)(fakeMessage({ content: "/unlock", chatType }));
      expect(channel.sent.filter((record) => record.chatId === "ou_me")).toHaveLength(2);
      expect(channel.texts()[0]).not.toContain("/approve");
      expect(channel.texts()[1]).toBe("/approve approval-request <code>");
      expect(run).not.toHaveBeenCalled();
      if (chatType === "group") {
        expect(channel.texts()[2]).not.toContain("approval-request");
        expect(channel.sent[2]?.chatId).toBe("chat-1");
      } else expect(channel.sent).toHaveLength(2);
    },
  );

  it.each(["text", "audio", "image"])(
    "blocks locked %s before routing or downloads",
    async (rawContentType) => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      deps.remoteAccess = {
        capture: () => {
          throw new Error("locked");
        },
      } as unknown as RemoteAccessService;
      const run = vi.fn(async () => {});
      await secureLarkMessage(
        channel,
        deps,
        run,
      )(fakeMessage({ rawContentType, content: "hello" }));
      expect(run).not.toHaveBeenCalled();
      expect(channel.sent).toHaveLength(1);
    },
  );

  it("keeps unknown identities silent even for security commands", async () => {
    const channel = fakeChannel();
    const run = vi.fn(async () => {});
    await secureLarkMessage(
      channel,
      fakeDeps(),
      run,
    )(fakeMessage({ senderId: "ou_stranger", content: "/security" }));
    expect(run).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
  });
});
