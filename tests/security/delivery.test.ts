import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOTP } from "otpauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeMessage } from "../../src/core/command/dispatch.js";
import { MessageQueue, type QueuedMessage } from "../../src/core/command/queue.js";
import { runRemoteIngress } from "../../src/core/security/ingress.js";
import { RemoteAccessService } from "../../src/core/security/remote-access.js";
import { fakeDeps } from "../adapters/lark/_fakes.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tcb-security-delivery-"));
  directories.push(directory);
  let now = 60_000;
  const service = new RemoteAccessService({ directory, now: () => now });
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const code = () => new TOTP({ secret, digits: 6, period: 30 }).generate({ timestamp: now });
  service.enroll(secret, code());
  now += 30_000;
  const principal = { channel: "telegram" as const, userId: "123", chatId: "123" };
  service.approve(principal, service.request(principal).id, code());
  return {
    service,
    principal,
    directory,
    expire: () => {
      now += 86_400_000;
    },
  };
}
function message(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "remote",
    text: "hello",
    chatId: "123",
    channel: "telegram",
    sessionName: "proj-1",
    action: "text",
    resolve: () => {},
    reject: () => {},
    ...overrides,
  };
}
function ingress(f: ReturnType<typeof fixture>, run: () => Promise<void>) {
  return runRemoteIngress({
    service: f.service,
    principal: f.principal,
    privateChat: true,
    text: "hello",
    reply: async () => {},
    sendPrivate: async () => {},
    run,
  });
}
describe("admission-only remote authorization", () => {
  it("delivers admitted input when authorization expires during readiness waits", async () => {
    const f = fixture();
    const deps = fakeDeps({
      bridge: { hasSession: vi.fn(async () => true) },
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilInputReady: vi.fn(async () => f.expire()),
      },
    });
    deps.remoteAccess = f.service;
    await expect(
      ingress(f, async () => {
        await executeMessage(message(), deps);
      }),
    ).resolves.toBe(true);
    expect(deps.bridge.sendKeys).toHaveBeenCalled();
    const next = vi.fn(async () => {});
    expect(await ingress(f, next)).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
  it.each(["lock", "revoke", "expire"] as const)(
    "keeps admitted queued input after %s and blocks new input",
    async (action) => {
      const f = fixture();
      const queue = new MessageQueue(30, join(f.directory, "queue.json"));
      const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => true) } });
      deps.remoteAccess = f.service;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let complete!: () => void;
      const done = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const reject = vi.fn(() => complete());
      queue.setHandler(async (msg) => {
        if (msg.id === "blocker") {
          await waiting;
          return;
        }
        try {
          msg.resolve(await executeMessage(msg, deps));
        } catch (error) {
          msg.reject(error as Error);
        }
      });
      queue.enqueue(message({ id: "blocker", channel: "control", action: "status" }));
      await ingress(f, async () => {
        queue.enqueue(message({ resolve: complete, reject }));
      });
      if (action === "lock") f.service.lock(f.principal);
      else if (action === "revoke") f.service.revoke();
      else f.expire();
      const next = vi.fn(async () => {});
      expect(await ingress(f, next)).toBe(false);
      expect(next).not.toHaveBeenCalled();
      release();
      await done;
      expect(reject).not.toHaveBeenCalled();
      expect(deps.bridge.sendKeys).toHaveBeenCalled();
    },
  );
});
