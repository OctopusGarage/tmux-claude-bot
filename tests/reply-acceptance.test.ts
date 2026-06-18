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

describe("queue acceptance replies", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rt-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records queue acceptance '已接收' message ID in replyTarget", async () => {
    const ctx = createMockContext();
    const msgId = 777;
    (ctx.reply as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ message_id: msgId }) // queue acceptance reply
      .mockResolvedValueOnce({ message_id: 888 }); // queued response (second call)

    const rt = createReplyTargetMap(tmpDir);

    // Simulate: queue was empty → "已接收" reply first
    await reply(ctx, "ok", "已接收", { session: "tmux_proj_test", replyTarget: rt });

    const resolved = rt.resolveReplyTarget(msgId);
    expect(resolved).toBe("tmux_proj_test");
  });

  it("records queue position reply message ID in replyTarget", async () => {
    const ctx = createMockContext();
    const msgId = 555;
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: msgId });

    const rt = createReplyTargetMap(tmpDir);

    // Simulate: queue had items → "已进队列" reply
    await reply(ctx, "queued", "已进队列，位置 3", { session: "tmux_proj_test", replyTarget: rt });

    expect(rt.resolveReplyTarget(msgId)).toBe("tmux_proj_test");
  });

  it("acceptance replies without replyTarget do NOT record (safety check)", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: 999 });

    const rt = createReplyTargetMap(tmpDir);

    // No replyTarget passed — nothing recorded
    await reply(ctx, "ok", "已接收", { session: "tmux_proj_test" });

    expect(rt.resolveReplyTarget(999)).toBeNull();
  });
});
