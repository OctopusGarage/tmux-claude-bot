import { describe, expect, it, vi } from "vitest";
import { secureLarkMessage } from "../../../src/adapters/lark/security.js";
import type { RemoteAccessService } from "../../../src/core/security/remote-access.js";
import { fakeChannel, fakeDeps, fakeMessage } from "./_fakes.js";

describe("Lark remote access guard", () => {
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
