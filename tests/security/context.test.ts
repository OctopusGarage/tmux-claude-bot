import { describe, expect, it, vi } from "vitest";
import {
  captureRemoteAuthorization,
  checkRemoteAuthorization,
  withAcceptedWorkOrderContext,
  withQueuedRemoteContext,
  withRemoteAccessContext,
} from "../../src/core/security/context.js";
import type {
  RemoteAccessService,
  RemoteAuthorization,
} from "../../src/core/security/remote-access.js";

const principal = { channel: "telegram" as const, userId: "123", chatId: "123" };
const authorization: RemoteAuthorization = { principal, grantId: "grant", generation: "one" };

function service() {
  return {
    capture: vi.fn(() => authorization),
    authorize: vi.fn(),
  } as unknown as RemoteAccessService;
}

describe("remote request provenance", () => {
  it("transfers already admitted WorkOrder lifecycle to independent authority", async () => {
    const auth = service();
    await withRemoteAccessContext(auth, principal, async () => {
      await withAcceptedWorkOrderContext(async () => {
        await Promise.resolve();
        expect(captureRemoteAuthorization()).toBeUndefined();
        checkRemoteAuthorization({ channel: "control", origin: "system" }, auth);
      });
      expect(auth.authorize).not.toHaveBeenCalled();
      expect(captureRemoteAuthorization()).toEqual(authorization);
    });
  });
  it("carries the original grant across asynchronous internal work", async () => {
    const auth = service();
    await withRemoteAccessContext(auth, principal, async () => {
      await Promise.resolve();
      expect(captureRemoteAuthorization()).toEqual(authorization);
      checkRemoteAuthorization({ channel: "control", origin: "system" }, auth);
      expect(auth.authorize).toHaveBeenCalledWith(authorization, undefined);
    });
    expect(captureRemoteAuthorization()).toBeUndefined();
  });

  it("rechecks the original grant rather than accepting a replacement unlock", () => {
    const auth = service();
    const replacement = { ...authorization, grantId: "replacement" };
    withRemoteAccessContext(auth, principal, () => {
      vi.mocked(auth.capture).mockReturnValue(replacement);
      expect(captureRemoteAuthorization()).toEqual(authorization);
    });
  });

  it("requires authorization for restored remote input even when marked system", () => {
    const auth = service();
    checkRemoteAuthorization({ channel: "telegram", chatId: "123", origin: "system" }, auth);
    expect(auth.authorize).toHaveBeenCalledWith(undefined, { channel: "telegram", chatId: "123" });
  });

  it("keeps independent scheduled and local control work separate", () => {
    const auth = service();
    checkRemoteAuthorization({ channel: "control", origin: "system" }, auth);
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it("clears a queue processor's inherited context for independent background work", () => {
    const auth = service();
    withRemoteAccessContext(auth, principal, () => {
      withQueuedRemoteContext(undefined, () => {
        checkRemoteAuthorization({ channel: "control", origin: "system" }, auth);
        expect(captureRemoteAuthorization()).toBeUndefined();
      });
      expect(auth.authorize).not.toHaveBeenCalled();
    });
  });

  it("binds a queued grant to its actual delivery channel and chat", () => {
    const auth = service();
    checkRemoteAuthorization(
      { channel: "lark", chatId: "another-chat", remoteAuthorization: authorization },
      auth,
    );
    expect(auth.authorize).toHaveBeenCalledWith(authorization, {
      channel: "lark",
      chatId: "another-chat",
    });
  });
});
