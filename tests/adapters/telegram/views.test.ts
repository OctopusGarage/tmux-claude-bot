import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import {
  sendAliveList,
  sendHistory,
  sendPeek,
  sendQueueStatus,
} from "../../../src/adapters/telegram/views.js";
import type { QueuedMessage } from "../../../src/core/queue.js";
import { setPathForSession } from "../../../src/core/sessionPathMap.js";
import { fakeCtx, fakeDeps } from "./_fakes.js";

const replyTarget = createReplyTargetMap(`/tmp/tg-views-rt-${Date.now()}`);

const qmsg = (text: string): QueuedMessage =>
  ({ id: "x", text, chatId: 0, action: "text", resolve() {}, reject() {} }) as QueuedMessage;

describe("sendQueueStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the in-flight msg under ▶ and only waiting items under 排队中", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({
      queue: {
        getGlobalQueue: vi.fn(() => [qmsg("waiting-1"), qmsg("waiting-2")]),
        isGlobalProcessing: vi.fn(() => true),
        getCurrentGlobalMessage: vi.fn(() => qmsg("in-flight")),
        getSessionNames: vi.fn(() => []),
      },
    });

    await sendQueueStatus(ctx, deps);

    const text = ctx.texts().join("\n");
    expect(text).toContain("排队中： 2");
    expect(text).toContain("▶ in-flight");
    // the in-flight message is rendered under ▶, never counted into 排队中.
    expect(text).not.toContain("排队中： 3");
  });

  it("renders per-session queues with the project label", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({
      queue: {
        getGlobalQueue: vi.fn(() => []),
        getSessionNames: vi.fn(() => ["tmux_proj_zeta"]),
        getSessionQueue: vi.fn(() => [qmsg("s-waiting")]),
        isSessionProcessing: vi.fn(() => true),
        getCurrentSessionMessage: vi.fn(() => qmsg("s-inflight")),
        getLastProcessedAt: vi.fn(() => undefined),
      },
    });

    await sendQueueStatus(ctx, deps);

    const text = ctx.texts().join("\n");
    expect(text).toContain("▶ s-inflight");
    expect(text).toContain("1. s-waiting");
  });

  it("reports an empty session queue section when there are no sessions", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({
      queue: {
        getGlobalQueue: vi.fn(() => []),
        getSessionNames: vi.fn(() => []),
      },
    });

    await sendQueueStatus(ctx, deps);

    expect(ctx.texts().join("\n")).toContain("没有活跃的会话队列");
  });
});

describe("sendAliveList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a hint with no keyboard when there are no alive projects", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({ bridge: { listProjectSessions: vi.fn(async () => []) } });

    await sendAliveList(ctx, deps);

    expect(ctx.texts().some((t) => t.includes("没有活跃项目"))).toBe(true);
    expect(ctx.replies[0]?.extra.reply_markup).toBeUndefined();
  });

  it("sends the alive count with an inline project keyboard", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-alive-"));
    setPathForSession("tmux_proj_alive", dir);
    const ctx = fakeCtx();
    const deps = fakeDeps({
      bridge: { listProjectSessions: vi.fn(async () => ["tmux_proj_alive"]) },
    });

    await sendAliveList(ctx, deps);

    expect(ctx.texts().some((t) => t.includes("活跃项目 (1)"))).toBe(true);
    expect(ctx.replies[0]?.extra.reply_markup).toBeDefined();
  });
});

describe("sendPeek", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends the captured pane as a code body with a control keyboard", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({
      bridge: { capturePane: vi.fn(async () => "PANE TEXT") },
      output: { process: vi.fn((s: string) => s) },
    });

    await sendPeek(ctx, deps, "proj-1", replyTarget);

    expect(ctx.texts().some((t) => t.includes("PANE TEXT"))).toBe(true);
    expect(ctx.replies[0]?.extra.reply_markup).toBeDefined();
  });

  it("sends （空）when the processed pane is empty", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({
      bridge: { capturePane: vi.fn(async () => "") },
      output: { process: vi.fn(() => "") },
    });

    await sendPeek(ctx, deps, "proj-1", replyTarget);

    expect(ctx.texts().some((t) => t.includes("（空）"))).toBe(true);
  });

  it("replies the error when capturePane throws", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({
      bridge: {
        capturePane: vi.fn(async () => {
          throw new Error("no pane");
        }),
      },
    });

    await sendPeek(ctx, deps, "proj-1", replyTarget);

    expect(ctx.texts().some((t) => t.includes("no pane"))).toBe(true);
  });
});

describe("sendHistory", () => {
  beforeEach(() => vi.clearAllMocks());

  it("warns when there is no project-path mapping", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();

    await sendHistory(ctx, deps, "proj-no-path", 0, replyTarget);

    expect(ctx.texts().some((t) => t.includes("缺少项目路径映射"))).toBe(true);
  });
});

afterAll(() => {
  // nothing persistent created beyond temp dirs left for the OS to reap.
});
