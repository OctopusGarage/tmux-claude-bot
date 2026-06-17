import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueLarkAction, runImmediateLarkAction } from "../../../src/adapters/lark/executor.js";
import { fakeChannel, fakeDeps } from "./_fakes.js";

describe("enqueueLarkAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with no current session replies the no-project hint (no enqueue)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi");

    expect(deps.queue.enqueued).toHaveLength(0);
    // No "/" discovery on Feishu — the no-project reply is a recovery card.
    expect(JSON.stringify(channel.cards())).toContain("无当前项目");
  });

  it("acks '已接收' when the queue was empty", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ queueSize: 0 });

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi");

    expect(channel.texts().some((t) => t.includes("已接收"))).toBe(true);
    // the 📂 project tag rides along
    expect(channel.texts().some((t) => t.includes("📂"))).toBe(true);
  });

  it("acks '已排队 · 第 N 位' when the queue was non-empty", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ queueSize: 2 });

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi");

    expect(channel.texts().some((t) => t.includes("已排队 · 第 2 位"))).toBe(true);
  });

  it("replies queue-full when enqueue is rejected", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ queueFull: true });

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi");

    expect(channel.texts().some((t) => t.includes("队列已满"))).toBe(true);
  });

  it("on resolve of a 'text' action, replies a result card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi");
    deps.queue.resolveLast("Claude says hi");
    await vi.waitFor(() => expect(channel.cards().length).toBeGreaterThanOrEqual(1));

    expect(channel.cards()).toHaveLength(1);
  });

  it("on resolve of a non-'text' action, replies plain text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "start", "/start");
    deps.queue.resolveLast("started");
    await vi.waitFor(() => expect(channel.texts().some((t) => t.includes("started"))).toBe(true));

    expect(channel.cards()).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("started"))).toBe(true);
  });

  it("the enqueued message carries a notify channel that sends plain text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi");

    const queuedMsg = deps.queue.enqueued[0];
    expect(queuedMsg?.notify).toBeTypeOf("function");
    queuedMsg?.notify?.("⏳ 仍在运行");
    await vi.waitFor(() =>
      expect(channel.texts().some((t) => t.includes("⏳ 仍在运行") && t.includes("📂"))).toBe(true),
    );
  });

  it("uses sessionOverride instead of the current project", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-current" });

    await enqueueLarkAction(channel, deps, "chat-1", "msg-1", "text", "hi", "proj-override");

    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-override");
    // currentProject.get is not consulted when an override is supplied
    expect(deps.currentProject.get).not.toHaveBeenCalled();
  });
});

describe("runImmediateLarkAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with no session replies the no-project hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });

    await runImmediateLarkAction(channel, deps, "chat-1", "msg-1", "status");

    expect(JSON.stringify(channel.cards())).toContain("无当前项目");
  });

  it("runs executeMessage and replies plain text with the result", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });

    await runImmediateLarkAction(channel, deps, "chat-1", "msg-1", "status");

    expect(channel.cards()).toHaveLength(0);
    // executeMessage("status") returns "🟢 Claude 运行中" plus the 📂 tag.
    expect(channel.texts().some((t) => t.includes("运行中"))).toBe(true);
    expect(channel.texts().some((t) => t.includes("📂"))).toBe(true);
  });

  it("on error replies the error message", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      // force executeMessage to throw during a status action.
      agent: {
        checkIfRunning: vi.fn(async () => {
          throw new Error("boom");
        }),
      },
    });

    await runImmediateLarkAction(channel, deps, "chat-1", "msg-1", "status");

    // Errors come back as a recovery card (start/restart + controls).
    expect(JSON.stringify(channel.cards())).toContain("错误：boom");
  });
});
