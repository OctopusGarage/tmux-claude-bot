import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the voice path deterministic & fast: stub voice readiness so the audio
// route returns the hint immediately instead of spawning real whisper.
// Pass through VOICE_LANGS so voiceLangCard (used by /voice_lang) still works.
vi.mock(import("../../../src/core/voice-support.js"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkVoiceSupport: () => ({ ready: false, reason: "not-installed" }),
    resolveWhisperLanguage: () => "en",
  };
});

const { makeMessageHandler } = await import("../../../src/adapters/lark/handlers.js");
const { recordReplyTarget, removeReplyTargetSession } = await import(
  "../../../src/adapters/lark/reply-target.js"
);
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");

describe("makeMessageHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops messages from non-allowlisted open_id (no send, no enqueue)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ senderId: "ou_stranger", content: "hi" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("ignores non-p2p chats", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    // chatType cast through fakeMessage's partial
    await handler(fakeMessage({ chatType: "group" as never, content: "hi" }));

    expect(channel.sent).toHaveLength(0);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("routes audio resources to the voice handler path (non-text content)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(
      fakeMessage({
        rawContentType: "audio",
        content: "",
        resources: [{ type: "audio", fileKey: "fk-1" }] as never,
      }),
    );

    // The voice handler ran (offered the one-tap install card) — NOT the
    // unsupported-media message.
    expect(JSON.stringify(channel.cards())).toContain("voiceinstall");
    expect(channel.texts().join("\n")).not.toContain("暂仅支持文本和语音消息");
  });

  it("replies unsupported for non-text, non-audio media", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(
      fakeMessage({
        rawContentType: "image",
        content: "",
        resources: [{ type: "image", fileKey: "fk-img" }] as never,
      }),
    );

    expect(channel.texts()).toContain("暂仅支持文本和语音消息");
  });

  it("enqueues plain text as a 'text' action after the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "do something" }));
      // Inside the quiet window nothing is enqueued yet.
      expect(deps.queue.enqueued).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(600);
      expect(deps.queue.enqueued).toHaveLength(1);
      expect(deps.queue.enqueued[0]?.action).toBe("text");
      expect(deps.queue.enqueued[0]?.text).toBe("do something");
      expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("merges rapid-fire texts into a single prompt", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "first line" }));
      await vi.advanceTimersByTimeAsync(200);
      await handler(fakeMessage({ content: "second line" }));
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.queue.enqueued).toHaveLength(1);
      expect(deps.queue.enqueued[0]?.text).toBe("first line\nsecond line");
    } finally {
      vi.useRealTimers();
    }
  });

  it("texts sent during an active run accumulate and land as ONE follow-up prompt", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      // First message flushes and starts a run (resolve not called yet).
      await handler(fakeMessage({ content: "kick off" }));
      await vi.advanceTimersByTimeAsync(600);
      expect(deps.queue.enqueued).toHaveLength(1);

      // Messages during the run must NOT flush, however long it takes.
      await handler(fakeMessage({ content: "also check tests" }));
      await vi.advanceTimersByTimeAsync(1800);
      await handler(fakeMessage({ content: "and update docs" }));
      await vi.advanceTimersByTimeAsync(1800);
      expect(deps.queue.enqueued).toHaveLength(1);

      // Run ends → fresh quiet window → one merged follow-up prompt.
      deps.queue.resolveLast("done");
      await vi.advanceTimersByTimeAsync(600);
      expect(deps.queue.enqueued).toHaveLength(2);
      expect(deps.queue.enqueued[1]?.text).toBe("also check tests\nand update docs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rejected run also unblocks the debounce window", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "kick off" }));
      await vi.advanceTimersByTimeAsync(600);
      expect(deps.queue.enqueued).toHaveLength(1);

      await handler(fakeMessage({ content: "follow up" }));
      deps.queue.rejectLast(new Error("claude died"));
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.queue.enqueued).toHaveLength(2);
      expect(deps.queue.enqueued[1]?.text).toBe("follow up");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a flush with no current session does not jam later messages", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      const deps = fakeDeps({ session: null });
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "first" }));
      await vi.advanceTimersByTimeAsync(600);
      const cardsAfterFirst = channel.cards().length;
      expect(cardsAfterFirst).toBeGreaterThan(0); // recovery card

      // The early-return path must not leave the scope blocked forever.
      await handler(fakeMessage({ content: "second" }));
      await vi.advanceTimersByTimeAsync(600);
      expect(channel.cards().length).toBeGreaterThan(cardsAfterFirst);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores blank text (no enqueue)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "   " }));

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  });

  it("/help renders the help card", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/help" }));

    expect(channel.cards()).toHaveLength(1);
  });

  it("an immediate command runs directly via executeMessage (plain text reply)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/status" }));

    // immediate path: no enqueue, replies plain text containing the result.
    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("运行中"))).toBe(true);
  });

  it("a queued command (/start) is enqueued, not run immediately", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/start" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("start");
  });

  it("unknown command replies the unknown-command hint", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/bogus" }));

    expect(channel.texts().some((t) => t.includes("未知命令：/bogus"))).toBe(true);
  });

  describe("view commands dispatch to the right view fn", () => {
    it("/peek captures the pane and sends a card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/peek" }));

      expect(deps.bridge.capturePane).toHaveBeenCalledWith("proj-1");
      expect(channel.cards()).toHaveLength(1);
    });

    it("/current_project reports the current project", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/current_project" }));

      expect(channel.texts().some((t) => t.includes("当前项目"))).toBe(true);
    });

    it("/queue_status sends the queue status text", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/queue_status" }));

      expect(channel.texts().some((t) => t.includes("全局队列"))).toBe(true);
    });

    it("/list_alive_projects sends the project list card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/list_alive_projects" }));

      expect(channel.cards()).toHaveLength(1);
    });

    it("/list_recent_projects sends the recent list card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/list_recent_projects" }));

      expect(channel.cards()).toHaveLength(1);
    });

    it("/add_project with no arg replies usage", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/add_project" }));

      expect(channel.texts().some((t) => t.includes("用法：/add_project"))).toBe(true);
    });

    it("/add_project with an arg calls addProject (path validation reply)", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/add_project /home/user/test-proj" }));

      expect(channel.texts().length).toBeGreaterThan(0);
    });

    it("/doctor sends a redacted health report", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/doctor" }));

      const report = channel.texts().join("\n");
      // Environment-independent: the summary always mentions "check"; the
      // chat rendering must carry no ANSI escapes.
      expect(report).toContain("check");
      expect(report).not.toContain("\x1b[");
    });

    it("/lang sends the language picker as a managed card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/lang" }));

      expect(channel.cardkitCreates).toHaveLength(1);
      expect(channel.imCreates).toHaveLength(1);
    });

    it("/voice_lang sends the voice language picker as a managed card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/voice_lang" }));

      expect(channel.cardkitCreates).toHaveLength(1);
      expect(channel.imCreates).toHaveLength(1);
    });

    it("/history 2 sends history at index 1", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/history 2" }));

      expect(channel.texts().length + channel.cards().length).toBeGreaterThan(0);
    });

    it("/ws delegates to handleWsCommand (list sends a reply)", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/ws list" }));

      expect(channel.texts().length).toBeGreaterThan(0);
    });
  });

  it("a reply to a session-bound bot message overrides the current session", async () => {
    vi.useFakeTimers();
    try {
      const channel = fakeChannel();
      const deps = fakeDeps({ session: "proj-current" });
      const handler = makeMessageHandler(channel, deps);

      recordReplyTarget("bot-msg-77", "proj-target");
      await handler(fakeMessage({ content: "follow up", replyToMessageId: "bot-msg-77" }));
      await vi.advanceTimersByTimeAsync(600);

      expect(deps.queue.enqueued).toHaveLength(1);
      expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-target");

      removeReplyTargetSession("proj-target");
    } finally {
      vi.useRealTimers();
    }
  });
});
