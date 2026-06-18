import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

vi.mock("../src/shared/utils/error.js", () => ({
  normalizeError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

import type { Context } from "grammy";
import { reply } from "../src/adapters/telegram/replies.js";
import { createReplyTargetMap } from "../src/adapters/telegram/reply-target.js";

function createMockContext(overrides: Partial<Context> = {}): Context {
  return {
    chat: { id: 12345 },
    message: {
      message_id: 999,
      date: 0,
      chat: { id: 12345, type: "private" } as any,
      reply_to_message: undefined,
    } as any,
    reply: vi.fn(),
    ...overrides,
  } as unknown as Context;
}

describe("reply-target integration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rt-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records sent message ID after successful reply", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValue({ message_id: 888 });

    const rt = createReplyTargetMap(tmpDir);
    await reply(ctx, "ok", "test", { session: "session-A", replyTarget: rt });

    const resolved = rt.resolveReplyTarget(888);
    expect(resolved).toBe("session-A");
  });

  it("does not record after reply fails", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network fail"));

    const rt = createReplyTargetMap(tmpDir);
    await reply(ctx, "ok", "test", { session: "session-B", replyTarget: rt }).catch(() => {});

    expect(rt.resolveReplyTarget(888)).toBeNull();
  });

  it("does not record when session is not provided", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValue({ message_id: 999 });

    const rt = createReplyTargetMap(tmpDir);
    await reply(ctx, "ok", "test", { replyTarget: rt });

    expect(rt.resolveReplyTarget(999)).toBeNull();
  });

  it("does not record when reply returns no message_id", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const rt = createReplyTargetMap(tmpDir);
    await reply(ctx, "ok", "test", { session: "session-C", replyTarget: rt });

    expect(rt.resolveReplyTarget(999)).toBeNull();
  });
});
