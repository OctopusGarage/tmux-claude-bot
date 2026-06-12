import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import { requireSession, resolveSessionFromReply } from "../../../src/adapters/telegram/session.js";
import { fakeCtx, fakeDeps } from "./_fakes.js";

describe("requireSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when there is no current project", async () => {
    const deps = fakeDeps({ session: null });
    expect(await requireSession(deps, 0)).toBeNull();
  });

  it("returns null when the session has no tmux session", async () => {
    const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => false) } });
    expect(await requireSession(deps, 0)).toBeNull();
  });

  it("returns null when the pane is not alive", async () => {
    const deps = fakeDeps({
      bridge: { hasSession: vi.fn(async () => true) },
      paneAlive: false,
    });
    expect(await requireSession(deps, 0)).toBeNull();
  });

  it("returns the session when present and the pane is alive", async () => {
    const deps = fakeDeps({
      session: "proj-1",
      bridge: { hasSession: vi.fn(async () => true) },
      paneAlive: true,
    });
    expect(await requireSession(deps, 0)).toBe("proj-1");
  });
});

describe("resolveSessionFromReply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the reply-target session when the message replies to a known bot message", async () => {
    const replyTarget = createReplyTargetMap(`/tmp/rt-${Date.now()}-${Math.random()}`);
    replyTarget.record(7, "proj-from-reply");
    const ctx = fakeCtx({ replyToMessageId: 7 });
    const deps = fakeDeps({ session: "proj-current" });

    expect(await resolveSessionFromReply(ctx, replyTarget, deps)).toBe("proj-from-reply");
  });

  it("falls back to requireSession when there is no reply-to", async () => {
    const replyTarget = createReplyTargetMap(`/tmp/rt-${Date.now()}-${Math.random()}`);
    const ctx = fakeCtx();
    const deps = fakeDeps({
      session: "proj-current",
      bridge: { hasSession: vi.fn(async () => true) },
      paneAlive: true,
    });

    expect(await resolveSessionFromReply(ctx, replyTarget, deps)).toBe("proj-current");
  });

  it("falls back to requireSession when the reply-to is unknown", async () => {
    const replyTarget = createReplyTargetMap(`/tmp/rt-${Date.now()}-${Math.random()}`);
    const ctx = fakeCtx({ replyToMessageId: 999 });
    const deps = fakeDeps({
      session: "proj-current",
      bridge: { hasSession: vi.fn(async () => true) },
      paneAlive: true,
    });

    expect(await resolveSessionFromReply(ctx, replyTarget, deps)).toBe("proj-current");
  });
});
