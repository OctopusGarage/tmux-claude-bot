import type { Bot, Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../src/core/deps.js";

vi.mock("../src/core/transcriber.js", () => ({
  transcribeWithCache: vi.fn(),
}));

// Voice is "ready" in tests so the handler proceeds to download + transcribe;
// readiness gating itself is covered by voice-support's own unit tests.
vi.mock("../src/core/voice-support.js", () => ({
  checkVoiceSupport: vi.fn(() => ({ ready: true, bin: "mlx_whisper" })),
  isVoicePlatformSupported: vi.fn(() => true),
  resolveWhisperLanguage: vi.fn(() => "zh"),
  persistWhisperBin: vi.fn(),
  persistEnvVar: vi.fn(),
  INSTALL_SCRIPT: "/repo/scripts/install-whisper.sh",
}));

vi.mock("../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createReplyTargetMap } from "../src/adapters/telegram/reply-target.js";
import { registerVoiceHandler } from "../src/adapters/telegram/voice-handler.js";
import { transcribeWithCache } from "../src/core/transcriber.js";

function createMockVoiceContext(): Context {
  return {
    chat: { id: 12345 },
    message: {
      message_id: 777,
      date: 0,
      chat: { id: 12345, type: "private" } as any,
      voice: { file_id: "voice123", duration: 5, mime_type: "audio/ogg" },
      reply_to_message: undefined,
    } as any,
    getFile: vi.fn().mockResolvedValue({
      file_path: "voice/file_0.ogg",
      download: vi.fn().mockResolvedValue("/tmp/test.ogg"),
    }),
    reply: vi.fn().mockResolvedValue({ message_id: 888 }),
    api: {
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as Context;
}

describe("registerVoiceHandler", () => {
  it("downloads voice file, transcribes, replies, enqueues", async () => {
    const deps = {
      currentProject: { get: vi.fn().mockResolvedValue("tmux_proj_test") },
      bridge: {
        hasSession: vi.fn().mockResolvedValue(true),
        isPaneAlive: vi.fn().mockResolvedValue(true),
      },
      claude: { checkIfRunning: vi.fn().mockResolvedValue(true) },
      queue: {
        enqueue: vi.fn().mockReturnValue(true),
        size: vi.fn().mockReturnValue(0),
        getMaxSize: vi.fn().mockReturnValue(100),
      },
      output: { process: vi.fn() },
      config: { maxMessageLength: 4000, projectSessionPrefix: "tmux_proj_" },
    } as unknown as HandlerDeps;
    const rt = createReplyTargetMap();
    const mockBot = { on: vi.fn(), command: vi.fn() } as unknown as Bot;
    const mockCtx = createMockVoiceContext();

    let capturedHandler: any;
    (mockBot.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: any) => {
      if (event === "message:voice") capturedHandler = handler;
    });

    (transcribeWithCache as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: "hello world",
    });

    registerVoiceHandler(mockBot, deps, rt);
    await capturedHandler(mockCtx);

    expect(mockCtx.getFile).toHaveBeenCalled();
    // The handler hands a telegram-scoped cache key, the resolved language/bin and
    // a bot-generated tmp path to the shared cache-aware transcriber.
    expect(transcribeWithCache).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: "telegram:voice123",
        bin: "mlx_whisper",
        language: "zh",
        tmpPath: expect.stringContaining("/tmp/voice_"),
      }),
    );
    const replyTexts = (mockCtx.reply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(
      replyTexts.some((t) => typeof t === "string" && t.includes("🎙️ 你说的是：「hello world」")),
    ).toBe(true);
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello world",
        sessionName: "tmux_proj_test",
        action: "text",
      }),
    );
  });

  it("its download callback fetches the voice file via the Bot API file.download", async () => {
    const deps = {
      currentProject: { get: vi.fn().mockResolvedValue("tmux_proj_test") },
      bridge: { hasSession: vi.fn().mockResolvedValue(true) },
      claude: { checkIfRunning: vi.fn().mockResolvedValue(true) },
      queue: { enqueue: vi.fn().mockReturnValue(true), size: vi.fn().mockReturnValue(0) },
      config: { projectSessionPrefix: "tmux_proj_" },
    } as unknown as HandlerDeps;
    const mockBot = { on: vi.fn(), command: vi.fn() } as unknown as Bot;
    const mockCtx = createMockVoiceContext();
    const fileDownload = vi.fn().mockResolvedValue("/tmp/test.ogg");
    (mockCtx.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      file_path: "voice/file_0.ogg", // not http → callback uses file.download
      download: fileDownload,
    });
    let capturedHandler: any;
    (mockBot.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: any) => {
      if (event === "message:voice") capturedHandler = handler;
    });
    (transcribeWithCache as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, text: "hi" });

    registerVoiceHandler(mockBot, deps, createReplyTargetMap());
    await capturedHandler(mockCtx);

    const calls = (transcribeWithCache as ReturnType<typeof vi.fn>).mock.calls;
    const opts = calls[calls.length - 1]?.[0] as { download: (tmp: string) => Promise<void> };
    await opts.download("/tmp/voice_abc.ogg");
    expect(fileDownload).toHaveBeenCalledWith("/tmp/voice_abc.ogg");
  });

  it("records replyTarget on transcription confirmation", async () => {
    const deps = {
      currentProject: { get: vi.fn().mockResolvedValue("tmux_proj_test") },
      bridge: {
        hasSession: vi.fn().mockResolvedValue(true),
        isPaneAlive: vi.fn().mockResolvedValue(true),
      },
      claude: { checkIfRunning: vi.fn().mockResolvedValue(true) },
      queue: {
        enqueue: vi.fn().mockReturnValue(true),
        size: vi.fn().mockReturnValue(0),
        getMaxSize: vi.fn().mockReturnValue(100),
      },
      output: { process: vi.fn() },
      config: { maxMessageLength: 4000, projectSessionPrefix: "tmux_proj_" },
    } as unknown as HandlerDeps;
    const rt = createReplyTargetMap();
    const mockBot = { on: vi.fn(), command: vi.fn() } as unknown as Bot;
    const mockCtx = createMockVoiceContext();

    let capturedHandler: any;
    (mockBot.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: any) => {
      if (event === "message:voice") capturedHandler = handler;
    });

    (transcribeWithCache as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      text: "hello world",
    });

    registerVoiceHandler(mockBot, deps, rt);
    await capturedHandler(mockCtx);

    // The confirmation reply message_id is 888
    expect(rt.resolveReplyTarget(888)).toBe("tmux_proj_test");
  });
});
