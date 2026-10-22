import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOTP } from "otpauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startActiveDelegatedTask } from "../../src/core/autopilot/delegated-task.js";
import { executeMessage } from "../../src/core/command/dispatch.js";
import { MessageQueue, type QueuedMessage } from "../../src/core/command/queue.js";
import {
  captureRemoteAuthorization,
  checkRemoteAuthorization,
  withAcceptedWorkOrderContext,
  withRemoteAccessContext,
} from "../../src/core/security/context.js";
import { RemoteAccessError, RemoteAccessService } from "../../src/core/security/remote-access.js";
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
  const totp = new TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 });
  service.enroll(secret, totp.generate({ timestamp: now }));
  now += 30_000;
  const principal = { channel: "telegram" as const, userId: "123", chatId: "123" };
  const request = service.request(principal);
  service.approve(principal, request.id, totp.generate({ timestamp: now }));
  return {
    service,
    principal,
    directory,
    expire: () => {
      now += 301_000;
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

describe("remote terminal delivery", () => {
  it("rejects a revoked delegation before inspecting or reserving project resources", async () => {
    const f = fixture();
    const deps = fakeDeps();
    deps.remoteAccess = f.service;
    await withRemoteAccessContext(f.service, f.principal, async () => {
      f.service.revoke();
      await expect(
        startActiveDelegatedTask(deps, { session: "proj-1", requirement: "maintain this project" }),
      ).rejects.toBeInstanceOf(RemoteAccessError);
    });
    expect(deps.queue.enqueued).toHaveLength(0);
    expect(deps.bridge.sendKeys).not.toHaveBeenCalled();
  });

  it("allows accepted lifecycle work after expiry while retaining the caller's expired grant", async () => {
    const f = fixture();
    await withRemoteAccessContext(f.service, f.principal, async () => {
      await withAcceptedWorkOrderContext(async () => {
        await Promise.resolve();
        f.expire();
        expect(captureRemoteAuthorization()).toBeUndefined();
        expect(() =>
          checkRemoteAuthorization({ channel: "control", origin: "system" }, f.service),
        ).not.toThrow();
      });
      expect(() => captureRemoteAuthorization()).toThrow(RemoteAccessError);
    });
  });

  it("does not grandfather legacy remote-derived work after enrollment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tcb-security-migration-"));
    directories.push(directory);
    const service = new RemoteAccessService({ directory, now: () => 60_000 });
    const principal = { channel: "telegram" as const, userId: "123", chatId: "123" };
    const queue = new MessageQueue(30, join(directory, "queue.json"));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = fakeDeps();
    deps.remoteAccess = service;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const reject = vi.fn(() => settled());
    const remote = message({
      id: "legacy-derived",
      channel: "control",
      origin: "system",
      reject,
      resolve: settled,
    });
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
    withRemoteAccessContext(service, principal, () => queue.enqueue(remote));
    expect(remote.remotePrincipal).toEqual(principal);
    expect(remote.ephemeral).toBe(true);
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    service.enroll(
      secret,
      new TOTP({ secret, digits: 6, period: 30 }).generate({ timestamp: 60_000 }),
    );
    release();
    await done;
    expect(reject).toHaveBeenCalledOnce();
    expect(deps.bridge.sendKeys).not.toHaveBeenCalled();
  });

  it("rechecks authorization after waiting for the agent's input surface", async () => {
    const f = fixture();
    const deps = fakeDeps({
      bridge: { hasSession: vi.fn(async () => true) },
      agent: {
        checkIfRunning: vi.fn(async () => true),
        waitUntilInputReady: vi.fn(async () => f.expire()),
      },
    });
    deps.remoteAccess = f.service;
    await withRemoteAccessContext(f.service, f.principal, async () => {
      await expect(executeMessage(message(), deps)).rejects.toThrow();
    });
    expect(deps.bridge.sendKeys).not.toHaveBeenCalled();
  });

  it("stamps queued system work from a remote request and rejects it after revocation", async () => {
    const f = fixture();
    const queuePath = join(f.directory, "queue.json");
    const queue = new MessageQueue(30, queuePath);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = fakeDeps();
    deps.remoteAccess = f.service;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const reject = vi.fn(() => settled());
    const remote = message({
      id: "derived",
      channel: "control",
      origin: "system",
      reject,
      resolve: settled,
    });
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
    queue.enqueue(message({ id: "blocker", action: "status", channel: "control" }));
    withRemoteAccessContext(f.service, f.principal, () => queue.enqueue(remote));
    expect(remote.remoteAuthorization?.principal).toEqual(f.principal);
    queue.flushPending();
    expect(readFileSync(queuePath, "utf8")).not.toContain("derived");
    f.service.revoke();
    release();
    await done;
    expect(reject).toHaveBeenCalledOnce();
    expect(deps.bridge.sendKeys).not.toHaveBeenCalled();
  });
});
