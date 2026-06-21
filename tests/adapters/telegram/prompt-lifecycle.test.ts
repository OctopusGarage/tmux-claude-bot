import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueCancelledError } from "../../../src/core/command/queue.js";
import { fakeDeps } from "../lark/_fakes.js";

// ── Mocked IO collaborators ────────────────────────────────────────────────
// We let the routing/decision logic in runPromptWithProgress run for real and
// only stub the side-effecting edges: the progress handle (startProgress), the
// typing indicator, the reactions, and the reply surface. Each mock records its
// calls so a test can assert WHAT was shown / enqueued / finalized — not how.

const finalize = vi.fn(async (..._args: unknown[]) => true);
const update = vi.fn(async (..._args: unknown[]) => {});
const stopTyping = vi.fn();

// startProgress is re-pointed per test (default: a real handle, messageId 42); some
// tests repoint it to a null handle — "progress failed" — via mockResolvedValueOnce.
type ProgressHandle = { messageId: number; update: typeof update; finalize: typeof finalize };
const startProgress = vi.fn<(..._args: unknown[]) => Promise<ProgressHandle | null>>(async () => ({
  messageId: 42,
  update,
  finalize,
}));

const reply = vi.fn(async (..._args: unknown[]) => {});
const reactToMessage = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../../../src/adapters/telegram/progress.js", () => ({
  startProgress: (...args: unknown[]) => startProgress(...args),
}));
vi.mock("../../../src/adapters/telegram/typing.js", () => ({
  startTyping: vi.fn(() => stopTyping),
}));
vi.mock("../../../src/adapters/telegram/reactions.js", () => ({
  REACTION: { received: "👀", done: "👍", failed: "😱" },
  reactToMessage: (...args: unknown[]) => reactToMessage(...args),
}));
vi.mock("../../../src/adapters/telegram/replies.js", () => ({
  reply: (...args: unknown[]) => reply(...args),
  // Fold the head + body into a single readable text (the real composer renders
  // both) so a test can assert the surfaced content through finalize, and pass
  // reply_markup through to extra — without coupling to the i18n catalog layout.
  composeMessage: (
    _kind: string,
    text: string,
    opts?: { body?: string; reply_markup?: unknown },
  ) => ({
    text: opts?.body ? `${text}\n${opts.body}` : text,
    extra: opts?.reply_markup ? { reply_markup: opts.reply_markup } : {},
  }),
}));

import {
  runPromptWithProgress,
  shouldSendCompletionPing,
} from "../../../src/adapters/telegram/prompt-lifecycle.js";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";

function fakeCtx() {
  return {
    chat: { id: 123 },
    message: { message_id: 5 },
    api: {},
  } as unknown as Parameters<typeof runPromptWithProgress>[0];
}

/** A ctx with no incoming user message (e.g. a synthesized prompt) — exercises
 *  the `userMsgId === undefined` branches (no received/done reaction). */
function ctxWithoutMessage() {
  return {
    chat: { id: 123 },
    message: undefined,
    api: {},
  } as unknown as Parameters<typeof runPromptWithProgress>[0];
}

function replyTarget() {
  return createReplyTargetMap("/tmp/tcb-prompt-lifecycle-test");
}

beforeEach(() => {
  // English copy so behavior assertions can match readable substrings.
  process.env.TELEGRAM_UI_LANG = "en";
  finalize.mockClear();
  finalize.mockResolvedValue(true);
  update.mockClear();
  stopTyping.mockClear();
  reply.mockClear();
  reactToMessage.mockClear();
  startProgress.mockClear();
  startProgress.mockImplementation(async () => ({ messageId: 42, update, finalize }));
});

afterEach(() => {
  delete process.env.TELEGRAM_UI_LANG;
});

describe("runPromptWithProgress — ack routing (queuePosition decision)", () => {
  it("runs immediately when the queue is empty: no cancel keyboard, no queue-ack bound", async () => {
    const deps = fakeDeps({ queueSize: 0 });
    const rt = replyTarget();

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", rt);

    // startProgress called with (api, chatId, thinkingText, extra). The 4th arg
    // (extra) must NOT carry a cancel keyboard when nothing precedes this prompt.
    const extra = startProgress.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(extra.reply_markup).toBeUndefined();
    expect(extra.reply_to_message_id).toBe(5); // bound to the user's message

    // The prompt was enqueued, and no per-item cancel ack was registered.
    expect(deps.queue.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.queue.setQueueAck).not.toHaveBeenCalled();

    // A silent 👀 ack went on the user's message.
    expect(reactToMessage).toHaveBeenCalledWith(expect.anything(), 123, 5, "👀");
  });

  it("attaches a ❌ cancel keyboard and binds a queue-ack when queued behind others", async () => {
    const deps = fakeDeps({ queueSize: 2 }); // 2 ahead → cancellable text prompt
    const rt = replyTarget();

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", rt);

    // Cancel keyboard present on the progress message.
    const extra = startProgress.mock.calls[0]?.[3] as { reply_markup?: unknown };
    expect(extra.reply_markup).toBeDefined();

    // On a real "queued" verdict with a cancel kb + progress, the ack is bound so a
    // reply rewrites THIS item. Bound to the session + the progress message id.
    expect(deps.queue.setQueueAck).toHaveBeenCalledTimes(1);
    const [session, , ackMsgId] = (deps.queue.setQueueAck as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(session).toBe("tmux_proj_x");
    expect(ackMsgId).toBe("42"); // String(progress.messageId)
  });

  it("does NOT bind a queue-ack when there is no progress handle", async () => {
    startProgress.mockImplementation(async () => null);
    const deps = fakeDeps({ queueSize: 2 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());

    // No progress message to bind the cancel ack to → setQueueAck withheld.
    expect(deps.queue.setQueueAck).not.toHaveBeenCalled();
  });
});

describe("runPromptWithProgress — progress ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks the elapsed-time update and re-attaches the cancel keyboard while queued", async () => {
    const deps = fakeDeps({ queueSize: 2 }); // cancellable → keyboard must persist
    update.mockClear();

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());

    vi.advanceTimersByTime(5_000); // one PROGRESS_TICK_MS
    await vi.waitFor(() => expect(update).toHaveBeenCalled());

    // editMessageText drops markup, so each tick must re-pass the cancel keyboard.
    const tickExtra = update.mock.calls[0]?.[1] as { reply_markup?: unknown };
    expect(tickExtra.reply_markup).toBeDefined();
  });
});

describe("runPromptWithProgress — queue full", () => {
  it("tears down the lifecycle and sends a queue-full error reply", async () => {
    const deps = fakeDeps({ queueFull: true });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());

    expect(stopTyping).toHaveBeenCalledTimes(1); // typing indicator stopped
    // An error reply went out (kind "err"); no finalize (no result to deliver).
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[1]).toBe("err");
    expect(finalize).not.toHaveBeenCalled();
  });
});

describe("runPromptWithProgress — resolve (success delivery)", () => {
  it("on resolve: stops typing, 👍 the prompt, and finalizes with a control keyboard", async () => {
    const deps = fakeDeps({ queueSize: 0 });
    const rt = replyTarget();
    const recordSpy = vi.spyOn(rt, "record");

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", rt);
    stopTyping.mockClear(); // ignore any setup; only count the resolve teardown

    // Drive the queued message's resolve callback (work finished).
    deps.queue.resolveLast("all done");
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    expect(stopTyping).toHaveBeenCalledTimes(1); // cleanup ran
    expect(reactToMessage).toHaveBeenCalledWith(expect.anything(), 123, 5, "👍"); // done reaction
    // finalize received a control keyboard so the answer carries the control panel.
    const finalizeExtra = finalize.mock.calls[0]?.[1] as { reply_markup?: unknown };
    expect(finalizeExtra.reply_markup).toBeDefined();
    // The reply-target map recorded the answer's message id → session.
    expect(recordSpy).toHaveBeenCalledWith(42, "tmux_proj_x");
  });

  it("delivers an empty/whitespace result as a bodiless done message", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    finalize.mockClear();

    deps.queue.resolveLast("   "); // whitespace-only → no body, just the done head
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    // No body folded in (the composer got opts without `body`), still keyboarded.
    expect(finalize.mock.calls[0]?.[0]).not.toContain("\n");
    const extra = finalize.mock.calls[0]?.[1] as { reply_markup?: unknown };
    expect(extra.reply_markup).toBeDefined();
  });

  it("falls back to a fresh reply when the in-place edit fails", async () => {
    finalize.mockResolvedValue(false); // edit rejected by Telegram
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    deps.queue.resolveLast("answer");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(reply.mock.calls[0]?.[1]).toBe("result"); // fresh delivery after a failed edit
  });

  it("falls back to a fresh reply when there is no progress handle", async () => {
    startProgress.mockImplementation(async () => null);
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    deps.queue.resolveLast("output text");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    // No progress → deliver via a fresh "result" reply carrying a keyboard.
    expect(reply.mock.calls[0]?.[1]).toBe("result");
    const opts = reply.mock.calls[0]?.[3] as { replyMarkup?: unknown };
    expect(opts.replyMarkup).toBeDefined();
  });
});

describe("runPromptWithProgress — reject", () => {
  it("treats a QueueCancelledError as a plain confirmation, not a failure", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    finalize.mockClear();
    reactToMessage.mockClear();

    deps.queue.rejectLast(new QueueCancelledError("cancelled by user"));
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    // A 🗑 confirmation via finalize — NOT a 😱 failed reaction, NOT a reply.
    expect(finalize.mock.calls[0]?.[0]).toContain("🗑");
    expect(reactToMessage).not.toHaveBeenCalledWith(expect.anything(), 123, 5, "😱");
    expect(stopTyping).toHaveBeenCalled();
  });

  it("confirms a cancel via a fresh reply when there is no progress handle", async () => {
    startProgress.mockImplementation(async () => null);
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();
    reactToMessage.mockClear();

    deps.queue.rejectLast(new QueueCancelledError("cancelled"));
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    // No progress → the 🗑 confirmation goes via a fresh "ok" reply, not a failure.
    expect(reply.mock.calls[0]?.[1]).toBe("ok");
    expect(reply.mock.calls[0]?.[2]).toContain("🗑");
    expect(reactToMessage).not.toHaveBeenCalledWith(expect.anything(), 123, 5, "😱");
  });

  it("a real error: 😱 the prompt and finalize with the failure text", async () => {
    const deps = fakeDeps({ queueSize: 0 });
    const rt = replyTarget();
    const recordSpy = vi.spyOn(rt, "record");

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", rt);
    finalize.mockClear();
    reactToMessage.mockClear();

    deps.queue.rejectLast(new Error("boom"));
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    expect(reactToMessage).toHaveBeenCalledWith(expect.anything(), 123, 5, "😱"); // failed reaction
    expect(finalize.mock.calls[0]?.[0]).toContain("boom"); // error body surfaced via finalize
    expect(recordSpy).toHaveBeenCalledWith(42, "tmux_proj_x"); // recorded for reply-targeting
  });

  it("a real error whose in-place edit fails falls back to a fresh err reply", async () => {
    finalize.mockResolvedValue(false); // edit rejected
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    deps.queue.rejectLast(new Error("edit-fail boom"));
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(reply.mock.calls[0]?.[1]).toBe("err");
    const opts = reply.mock.calls[0]?.[3] as { body?: string };
    expect(opts.body).toContain("edit-fail boom");
  });

  it("a real error with no progress handle falls back to a fresh err reply", async () => {
    startProgress.mockImplementation(async () => null);
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    deps.queue.rejectLast(new Error("kaboom"));
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(reply.mock.calls[0]?.[1]).toBe("err");
    const opts = reply.mock.calls[0]?.[3] as { body?: string };
    expect(opts.body).toContain("kaboom");
  });
});

describe("runPromptWithProgress — duplicate without a progress handle", () => {
  it("replaces the deduped placeholder with a fresh info reply when there is no progress", async () => {
    startProgress.mockImplementation(async () => null);
    const deps = fakeDeps({ queue: { enqueue: vi.fn(() => "duplicate" as const) } });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());

    expect(stopTyping).toHaveBeenCalledTimes(1); // ticker/typing torn down
    expect(finalize).not.toHaveBeenCalled(); // no progress to finalize
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[1]).toBe("info"); // duplicate notice via a fresh reply
  });
});

describe("runPromptWithProgress — long-run completion ping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("on a >60s success: edits in place AND sends a fresh ping (edits don't notify)", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    // The in-place finalize is silent on Telegram; after a long run a fresh
    // "result" message is also sent to push-notify the (likely away) user.
    vi.advanceTimersByTime(61_000);
    deps.queue.resolveLast("done");
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(finalize).toHaveBeenCalled(); // in-place edit
    expect(reply.mock.calls[0]?.[1]).toBe("result"); // + a fresh notifying reply
  });

  it("on a >60s failure: finalize the error AND send a fresh ping", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    vi.advanceTimersByTime(61_000);
    deps.queue.rejectLast(new Error("late boom"));
    await vi.waitFor(() => expect(reply).toHaveBeenCalled());

    expect(finalize).toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[1]).toBe("err");
  });
});

describe("runPromptWithProgress — interim notify", () => {
  it("an interim notice from the queue goes out as a fresh info message", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(fakeCtx(), deps, "tmux_proj_x", "deploy", replyTarget());
    reply.mockClear();

    // The queued message exposes a `notify` callback the queue can call mid-run
    // (e.g. "still running"). It must surface as a NEW message (edits don't notify).
    const queued = (deps.queue as { enqueued: { notify?: (t: string) => void }[] }).enqueued[0];
    queued?.notify?.("still running");

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[1]).toBe("info");
    expect(reply.mock.calls[0]?.[2]).toBe("still running");
  });
});

describe("runPromptWithProgress — no incoming user message", () => {
  it("skips received/done reactions when there is no user message id", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(ctxWithoutMessage(), deps, "tmux_proj_x", "deploy", replyTarget());

    // No 👀 received-ack (nothing to react to).
    expect(reactToMessage).not.toHaveBeenCalled();
    // startProgress's extra carries no reply_to_message_id either.
    const extra = startProgress.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(extra.reply_to_message_id).toBeUndefined();

    reactToMessage.mockClear();
    deps.queue.resolveLast("done");
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());
    // Still no done-reaction without a user message.
    expect(reactToMessage).not.toHaveBeenCalled();
  });

  it("skips the 😱 failed reaction when an error arrives with no user message", async () => {
    const deps = fakeDeps({ queueSize: 0 });

    await runPromptWithProgress(ctxWithoutMessage(), deps, "tmux_proj_x", "deploy", replyTarget());
    reactToMessage.mockClear();
    finalize.mockClear();

    deps.queue.rejectLast(new Error("boom"));
    await vi.waitFor(() => expect(finalize).toHaveBeenCalled());

    // The failure still finalizes the message, but no reaction (nothing to react to).
    expect(reactToMessage).not.toHaveBeenCalled();
  });
});

describe("shouldSendCompletionPing", () => {
  it("pings only past the 60s threshold", () => {
    expect(shouldSendCompletionPing(0)).toBe(false);
    expect(shouldSendCompletionPing(60)).toBe(false); // boundary is exclusive
    expect(shouldSendCompletionPing(61)).toBe(true);
  });
});
