import { describe, expect, it, vi } from "vitest";
import { runRemoteIngress } from "../../src/core/security/ingress.js";
import type { RemoteAccessService } from "../../src/core/security/remote-access.js";

function input(text?: string) {
  const service = {
    status: vi.fn(() => ({ enabled: true, enrolled: true, suspended: false })),
    capture: vi.fn(() => {
      throw new Error("locked");
    }),
    authorize: vi.fn(),
    request: vi.fn(() => ({ id: "request-id", expiresAt: Date.now() + 60_000 })),
    approve: vi.fn(),
    lock: vi.fn(),
  };
  return {
    service: service as unknown as RemoteAccessService,
    principal: { channel: "telegram" as const, userId: "123", chatId: "123" },
    privateChat: true,
    text,
    reply: vi.fn(async (_text: string) => {}),
    sendPrivate: vi.fn(async (_text: string) => {}),
    removeSensitive: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    mock: service,
  };
}

describe("remote security ingress", () => {
  it.each([undefined, "ordinary prompt", "/key Ctrl+C"])(
    "blocks locked media, callbacks and text (%s)",
    async (text) => {
      const req = input(text);
      await runRemoteIngress(req);
      expect(req.run).not.toHaveBeenCalled();
      expect(req.reply).toHaveBeenCalled();
    },
  );

  it("preserves legacy behavior when enrollment has not enabled protection", async () => {
    const req = input("hello");
    req.mock.capture.mockImplementation(() => undefined as never);
    await runRemoteIngress(req);
    expect(req.run).toHaveBeenCalledOnce();
  });

  it("sends group unlock instructions privately without granting access", async () => {
    const req = input("/unlock");
    req.privateChat = false;
    req.principal.chatId = "-100";
    await runRemoteIngress(req);
    expect(req.mock.request).toHaveBeenCalledWith(req.principal);
    expect(req.sendPrivate).toHaveBeenCalledOnce();
    expect(req.run).not.toHaveBeenCalled();
    expect(req.mock.approve).not.toHaveBeenCalled();
  });

  it("never accepts or forwards an approval submitted in a group", async () => {
    const req = input("/approve request-id 123456");
    req.privateChat = false;
    await runRemoteIngress(req);
    expect(req.mock.approve).not.toHaveBeenCalled();
    expect(req.removeSensitive).toHaveBeenCalled();
    expect(req.run).not.toHaveBeenCalled();
  });

  it("consumes private approvals without sending codes to the agent", async () => {
    const req = input("/approve request-id 123456");
    await runRemoteIngress(req);
    expect(req.mock.approve).toHaveBeenCalledWith(req.principal, "request-id", "123456");
    expect(req.removeSensitive).toHaveBeenCalled();
    expect(req.run).not.toHaveBeenCalled();
  });

  it("keeps emergency locking available without an active grant", async () => {
    const req = input("/lock");
    await runRemoteIngress(req);
    expect(req.mock.lock).toHaveBeenCalledWith(req.principal);
    expect(req.run).not.toHaveBeenCalled();
  });

  it("does not echo or forward a bare verification code while protection is enabled", async () => {
    const req = input("123456");
    await runRemoteIngress(req);
    expect(req.removeSensitive).toHaveBeenCalled();
    expect(req.run).not.toHaveBeenCalled();
    expect(JSON.stringify(req.reply.mock.calls)).not.toContain("123456");
  });
});
