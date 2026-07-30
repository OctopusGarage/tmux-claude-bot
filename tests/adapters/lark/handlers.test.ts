import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the voice path deterministic & fast: stub voice readiness so the audio
// route returns the hint immediately instead of spawning real whisper.
// Pass through VOICE_LANGS so voiceLangCard (used by /voice_lang) still works.
vi.mock(import("../../../src/core/read/voice-support.js"), async (importOriginal) => {
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
const { requestNewFolder, startBrowse, clearBrowse } = await import(
  "../../../src/core/projects/dir-browser.js"
);
const { bindGroup } = await import("../../../src/core/projects/group-bindings.js");
const { chatScope } = await import("../../../src/core/projects/project-manager.js");
const { OpportunityStore } = await import("../../../src/core/opportunities/store.js");
const { fakeChannel, fakeDeps, fakeMessage } = await import("./_fakes.js");
const nodeFs = await import("node:fs");
const nodeOs = await import("node:os");
const nodePath = await import("node:path");

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

  it("reply to a queued ack rewrites that message in place (no new enqueue)", async () => {
    const channel = fakeChannel();
    // rewriteByAck resolves ack "ack-1" → its item and rewrites it in one pass.
    const rewriteByAck = vi.fn(() => ({ kind: "rewritten", session: "proj-1" }) as const);
    const deps = fakeDeps({ session: "proj-1", queue: { rewriteByAck } });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "use TypeScript instead", replyToMessageId: "ack-1" }));

    // Scoped by the ack's chat (fakeMessage's default chatId), not just the ack id.
    expect(rewriteByAck).toHaveBeenCalledWith("ack-1", "chat-1", "use TypeScript instead");
    expect(deps.queue.enqueued).toHaveLength(0); // replaced in place, not re-queued
    expect(channel.texts().some((t) => t.includes("改写"))).toBe(true);
  });

  it("reply to a queued ack is TERMINAL when the rewrite is dedup-blocked (no silent re-enqueue)", async () => {
    const channel = fakeChannel();
    // new text duplicates another queued item → blocked
    const rewriteByAck = vi.fn(() => ({ kind: "duplicate", session: "proj-1" }) as const);
    const deps = fakeDeps({ session: "proj-1", queue: { rewriteByAck } });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "same as another", replyToMessageId: "ack-1" }));

    expect(rewriteByAck).toHaveBeenCalled();
    // Must report the rejection, NOT fall through and re-enqueue the edit (which
    // dedup would then drop, losing it silently).
    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("忽略"))).toBe(true);
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

  it("handles /opportunity commands in bound project groups", async () => {
    const oldStateDir = process.env.TCB_STATE_DIR;
    process.env.TCB_STATE_DIR = nodeFs.mkdtempSync(
      nodePath.join(nodeOs.tmpdir(), "tcb-lark-opportunity-"),
    );
    try {
      bindGroup("chat-1", { workspacePath: "/tmp", sessionName: "proj-1", label: "tmp" });
      new OpportunityStore().upsertDiscoveryReport({
        report: {
          projectId: "tmp",
          projectName: "Tmp",
          generatedAt: "2026-07-29T09:00:00.000Z",
          coverage: "partial",
          checkedSignals: ["logs"],
          skippedSignals: [],
          suggestions: [
            {
              title: "Improve repair visibility",
              category: "developer-experience",
              confidence: "high",
              problem: "Repair status is hard to inspect.",
              whyNow: "Opportunity notifications are sent to project groups.",
              value: "Makes follow-up faster.",
              evidence: ["operator asked from the project group"],
              recommendedApproach: "Show repair status in the summary.",
              alternatives: ["Keep raw logs only"],
              acceptanceCriteria: ["The summary includes the opportunity"],
              risks: ["Message length can grow"],
              nonGoals: ["Do not start implementation"],
              estimatedComplexity: "small",
              delegateRequirement: "Improve repair visibility.",
            },
          ],
        },
        projectPath: "/tmp",
        runId: "run-1",
        cooldownDays: 14,
        now: Date.parse("2026-07-29T09:00:00Z"),
      });
      const channel = fakeChannel();
      const deps = fakeDeps({
        bridge: { hasSession: vi.fn(async () => true) },
        currentProject: { get: vi.fn(async () => "proj-1") },
      });
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ chatType: "group" as never, content: "/opportunity show 1" }));

      expect(channel.texts().join("\n")).toContain("Improve repair visibility");
      expect(deps.queue.enqueued).toHaveLength(0);
    } finally {
      if (oldStateDir === undefined) {
        delete process.env.TCB_STATE_DIR;
      } else {
        process.env.TCB_STATE_DIR = oldStateDir;
      }
    }
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

  it("enqueues plain text as a 'text' action immediately (no debounce, like Telegram)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "do something" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("text");
    expect(deps.queue.enqueued[0]?.text).toBe("do something");
    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-1");
  });

  it("enqueues one multi-line text message as one prompt", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "first line\nsecond line\nthird line" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("text");
    expect(deps.queue.enqueued[0]?.text).toBe("first line\nsecond line\nthird line");
  });

  it("records lark as the recent owner activity channel for accepted messages", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/help" }));

    expect(deps.ownerActivity.record).toHaveBeenCalledWith("lark");
  });

  it("enqueues each text SEPARATELY (no merge) — aligned with Telegram", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "first line" }));
    await handler(fakeMessage({ content: "second line" }));

    expect(deps.queue.enqueued).toHaveLength(2);
    expect(deps.queue.enqueued[0]?.text).toBe("first line");
    expect(deps.queue.enqueued[1]?.text).toBe("second line");
  });

  it("texts sent during an active run enqueue SEPARATELY and in order (not held/merged)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    // First message starts a run (resolve not called yet).
    await handler(fakeMessage({ content: "kick off" }));
    expect(deps.queue.enqueued).toHaveLength(1);

    // Messages sent DURING the run each land as their own queue item — they do
    // NOT wait for the run to settle and are NEVER merged into it. The per-session
    // FIFO serializes them after the running one.
    await handler(fakeMessage({ content: "also check tests" }));
    expect(deps.queue.enqueued).toHaveLength(2);
    expect(deps.queue.enqueued[1]?.text).toBe("also check tests");

    await handler(fakeMessage({ content: "and update docs" }));
    expect(deps.queue.enqueued).toHaveLength(3);
    expect(deps.queue.enqueued[2]?.text).toBe("and update docs");
  });

  it("a failed run does not jam later messages (they still enqueue)", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "kick off" }));
    expect(deps.queue.enqueued).toHaveLength(1);
    deps.queue.rejectLast(new Error("claude died"));

    await handler(fakeMessage({ content: "follow up" }));
    expect(deps.queue.enqueued).toHaveLength(2);
    expect(deps.queue.enqueued[1]?.text).toBe("follow up");
  });

  it("a no-current-session message still handles later messages", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ session: null });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "first" }));
    const cardsAfterFirst = channel.cards().length;
    expect(cardsAfterFirst).toBeGreaterThan(0); // recovery card

    // The no-session early return must not break subsequent messages.
    await handler(fakeMessage({ content: "second" }));
    expect(channel.cards().length).toBeGreaterThan(cardsAfterFirst);
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
    const deps = fakeDeps({ bridge: { hasSession: vi.fn(async () => true) } });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/status" }));

    // immediate path: no enqueue, replies plain text containing the result.
    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("运行中"))).toBe(true);
  });

  it("a queued command (/start) is enqueued, not run immediately", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => false) } });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/start" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("start");
  });

  it("/start reports already running instead of enqueueing", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/start" }));

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(channel.texts().some((t) => t.includes("已在运行"))).toBe(true);
  });

  it("/restart with multiple launch flavors opens the picker", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps({
      config: {
        startCommands: [
          { label: "Claude", command: "claude" },
          { label: "Codex", command: "codex" },
        ],
      },
    });
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/restart" }));

    expect(deps.queue.enqueued).toHaveLength(0);
    expect(JSON.stringify(channel.cards())).toContain("restartpick");
  });

  it("unknown slash commands are forwarded to the agent as text", async () => {
    const channel = fakeChannel();
    const deps = fakeDeps();
    const handler = makeMessageHandler(channel, deps);

    await handler(fakeMessage({ content: "/goal refactor with eval" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]).toMatchObject({
      action: "text",
      text: "/goal refactor with eval",
    });
  });

  describe("view commands dispatch to the right view fn", () => {
    it("/peek captures the pane and sends a card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/peek" }));

      expect(deps.bridge.capturePaneColored).toHaveBeenCalledWith("proj-1", expect.any(Number));
      expect(channel.cards()).toHaveLength(1);
    });

    it("/current_project reports the current project", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/current_project" }));

      expect(channel.texts().some((t) => t.includes("当前会话"))).toBe(true);
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

    it("/add_project with no arg opens the directory browser card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/add_project" }));

      // Opens as a regular interactive card (CardKit-entity button callbacks
      // don't fire reliably on Feishu), so it lands in cards().
      expect(JSON.stringify(channel.cards())).toContain("browsecancel");
    });

    it("/add_project with an arg calls addProject (path validation reply)", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/add_project /home/user/test-proj" }));

      expect(channel.texts().length).toBeGreaterThan(0);
    });

    it("a text message during a new-folder prompt creates the folder", async () => {
      const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "tcb-lk-nf-"));
      try {
        const scope = chatScope("lark", "chat-1");
        startBrowse(scope, [dir]); // single root → cwd = dir
        requestNewFolder(scope); // arm the capture
        const channel = fakeChannel();
        const deps = fakeDeps({ config: { cdAllowedDirs: [dir] } });
        await makeMessageHandler(channel, deps)(fakeMessage({ content: "fresh" }));
        expect(nodeFs.existsSync(nodePath.join(dir, "fresh"))).toBe(true);
      } finally {
        clearBrowse(chatScope("lark", "chat-1"));
        nodeFs.rmSync(dir, { recursive: true, force: true });
      }
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

    it("/lang sends the language picker card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/lang" }));

      expect(channel.cards()).toHaveLength(1);
    });

    it("/voice_lang sends the voice language picker card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/voice_lang" }));

      expect(channel.cards()).toHaveLength(1);
    });

    it("/prompt_translate sends the translation picker card", async () => {
      const channel = fakeChannel();
      const deps = fakeDeps();
      const handler = makeMessageHandler(channel, deps);

      await handler(fakeMessage({ content: "/prompt_translate" }));

      expect(channel.cards()).toHaveLength(1);
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
    const channel = fakeChannel();
    const deps = fakeDeps({ session: "proj-current" });
    const handler = makeMessageHandler(channel, deps);

    recordReplyTarget("bot-msg-77", "proj-target");
    await handler(fakeMessage({ content: "follow up", replyToMessageId: "bot-msg-77" }));

    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-target");

    removeReplyTargetSession("proj-target");
  });
});
