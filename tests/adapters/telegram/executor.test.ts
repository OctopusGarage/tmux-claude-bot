import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRestoredMessage,
  enqueueSessionCommand,
  handleQueuedCommand,
} from "../../../src/adapters/telegram/executor.js";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import type { PersistedMessage } from "../../../src/core/command/queue.js";
import { fakeBot, fakeCtx, fakeDeps } from "./_fakes.js";

describe("enqueueSessionCommand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("acks '已接收' when the queue was empty", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({ queueSize: 0 });

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi");

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(ctx.texts().some((t) => t.includes("已接收"))).toBe(true);
    // the 📂 project tag rides along
    expect(ctx.texts().some((t) => t.includes("📂"))).toBe(true);
  });

  it("acks '已排队 · 第 N 位' when the queue was non-empty", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({ queueSize: 2 });

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi");

    expect(ctx.texts().some((t) => t.includes("已排队 · 第 2 位"))).toBe(true);
  });

  it("replies queue-full when enqueue is rejected", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({ queueFull: true });

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi");

    expect(ctx.texts().some((t) => t.includes("队列已满"))).toBe(true);
  });

  it("tags the enqueued message channel:'telegram' and casts chatId to a number", async () => {
    const ctx = fakeCtx({ chatId: 555 });
    const deps = fakeDeps();

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi");

    const msg = deps.queue.enqueued[0];
    expect(msg?.channel).toBe("telegram");
    expect(msg?.chatId).toBe(555);
    expect(msg?.sessionName).toBe("proj-1");
    expect(msg?.action).toBe("text");
    expect(msg?.text).toBe("hi");
  });

  it("falls back to the action as text when no text is supplied", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();

    await enqueueSessionCommand(ctx, deps, "proj-1", "esc");

    expect(deps.queue.enqueued[0]?.text).toBe("esc");
  });

  it("on resolve, the default callback replies the output", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi");
    deps.queue.resolveLast("Claude says hi");
    await vi.waitFor(() =>
      expect(ctx.texts().some((t) => t.includes("Claude says hi"))).toBe(true),
    );
  });

  it("on reject, replies the error message", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi");
    deps.queue.rejectLast(new Error("boom"));
    await vi.waitFor(() => expect(ctx.texts().some((t) => t.includes("boom"))).toBe(true));
  });

  it("uses the supplied onResolve callback instead of the default", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();
    const onResolve = vi.fn();

    await enqueueSessionCommand(ctx, deps, "proj-1", "text", "hi", undefined, onResolve);
    deps.queue.resolveLast("out");

    expect(onResolve).toHaveBeenCalledWith("out");
  });
});

describe("handleQueuedCommand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("with no current session replies the no-session hint (no enqueue)", async () => {
    const ctx = fakeCtx({ text: "/esc" });
    const deps = fakeDeps({ session: null });

    await handleQueuedCommand(ctx, deps, "esc");

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(ctx.texts().some((t) => t.includes("没有活跃会话"))).toBe(true);
  });

  it("routes a non-immediate action through the queue (enqueue + ack)", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps();

    await handleQueuedCommand(ctx, deps, "text", "hi");

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-1");
    expect(ctx.texts().some((t) => t.includes("已接收"))).toBe(true);
  });

  it("runs an immediate action (status) inline without enqueuing", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });

    await handleQueuedCommand(ctx, deps, "status");

    expect(deps.queue.enqueued).toHaveLength(0);
    // executeMessage("status") returns "🟢 Claude 运行中".
    expect(ctx.texts().some((t) => t.includes("运行中"))).toBe(true);
  });

  it("runs 'tab' inline too (regression: telegram's immediate set once omitted tab)", async () => {
    // tab is queuePolicy:"immediate" in the registry; telegram now derives its
    // immediate set from there instead of a hardcoded list that had drifted.
    const ctx = fakeCtx();
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });

    await handleQueuedCommand(ctx, deps, "tab");

    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("resolves the session from a reply-to message via the reply-target map", async () => {
    const replyTarget = createReplyTargetMap(`/tmp/rt-${Date.now()}-${Math.random()}`);
    replyTarget.record(42, "proj-from-reply");
    const ctx = fakeCtx({ replyToMessageId: 42 });
    // current project differs, to prove the reply target wins.
    const deps = fakeDeps({ session: "proj-current" });

    await handleQueuedCommand(ctx, deps, "text", "hi", replyTarget);

    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-from-reply");
  });

  it("falls back to the current project when the reply-to is unknown", async () => {
    const replyTarget = createReplyTargetMap(`/tmp/rt-${Date.now()}-${Math.random()}`);
    const ctx = fakeCtx({ replyToMessageId: 999 });
    const deps = fakeDeps({ session: "proj-current" });

    await handleQueuedCommand(ctx, deps, "text", "hi", replyTarget);

    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-current");
  });

  it("requires an alive pane: dead pane → no-session hint", async () => {
    const ctx = fakeCtx();
    const deps = fakeDeps({ paneAlive: false });

    await handleQueuedCommand(ctx, deps, "text", "hi");

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(ctx.texts().some((t) => t.includes("没有活跃会话"))).toBe(true);
  });
});

describe("createRestoredMessage", () => {
  beforeEach(() => vi.clearAllMocks());

  const persisted = (over: Partial<PersistedMessage> = {}): PersistedMessage =>
    ({
      id: "p1",
      text: "restore me",
      chatId: 777,
      sessionName: "proj-1",
      action: "text",
      channel: "telegram",
      ...over,
    }) as PersistedMessage;

  it("carries over the persisted fields and tags channel:'telegram'", () => {
    const bot = fakeBot();
    const msg = createRestoredMessage(persisted(), bot);

    expect(msg.id).toBe("p1");
    expect(msg.text).toBe("restore me");
    expect(msg.sessionName).toBe("proj-1");
    expect(msg.channel).toBe("telegram");
  });

  it("on resolve sends a 'Recovered' message to the numeric chat id", async () => {
    const bot = fakeBot();
    const msg = createRestoredMessage(persisted({ chatId: "888" as unknown as number }), bot);

    msg.resolve("output text");
    await vi.waitFor(() => expect(bot.sent.length).toBeGreaterThanOrEqual(1));

    expect(bot.sent[0]?.chatId).toBe(888); // Number(chatId) cast
    expect(bot.sent[0]?.text).toContain("Recovered");
    expect(bot.texts().some((t) => t.includes("output text"))).toBe(true);
  });

  it("on reject sends a 'Recovered failed' message", async () => {
    const bot = fakeBot();
    const msg = createRestoredMessage(persisted(), bot);

    msg.reject(new Error("kaboom"));
    await vi.waitFor(() => expect(bot.sent.length).toBeGreaterThanOrEqual(1));

    expect(bot.texts().some((t) => t.includes("Recovered failed") && t.includes("kaboom"))).toBe(
      true,
    );
  });
});
