import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/utils/error.js", () => ({
  normalizeError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
}));

import type { Context } from "grammy";
import { reply } from "../src/bot/replies.js";
import { createReplyTargetMap } from "../src/services/reply-target.js";

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

describe("router enqueueTextToSession acceptance reply", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rt-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records acceptance '已接收' message ID (empty queue)", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: 111 });

    const rt = createReplyTargetMap(tmpDir);

    // FIXED: now passes replyTarget
    await reply(ctx, "ok", "已接收", { session: "tmux_proj_test", replyTarget: rt });

    expect(rt.resolveReplyTarget(111)).toBe("tmux_proj_test");
  });

  it("records queue position reply message ID", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: 333 });

    const rt = createReplyTargetMap(tmpDir);

    await reply(ctx, "queued", "已进队列，位置 3", { session: "tmux_proj_test", replyTarget: rt });

    expect(rt.resolveReplyTarget(333)).toBe("tmux_proj_test");
  });

  it("records error reply message ID", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: 444 });

    const rt = createReplyTargetMap(tmpDir);

    await reply(ctx, "err", "queue full", { session: "tmux_proj_test", replyTarget: rt });

    expect(rt.resolveReplyTarget(444)).toBe("tmux_proj_test");
  });

  it("completion reply (resolve callback) records its message ID", async () => {
    const ctx = createMockContext();
    const replyTo = 999;
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: 222 });

    const rt = createReplyTargetMap(tmpDir);

    // resolve callback fires after queue processing — calls reply with replyTo + replyTarget
    await reply(ctx, "info", "result", { session: "tmux_proj_test", replyTo, replyTarget: rt });

    // Completion message ID should be recorded
    expect(rt.resolveReplyTarget(222)).toBe("tmux_proj_test");
  });

  it("acceptance without replyTarget does NOT record (correct)", async () => {
    const ctx = createMockContext();
    (ctx.reply as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ message_id: 999 });

    const rt = createReplyTargetMap(tmpDir);

    // Current router behavior: no replyTarget passed
    await reply(ctx, "ok", "已接收", { session: "tmux_proj_test" });

    expect(rt.resolveReplyTarget(999)).toBeNull();
  });
});
