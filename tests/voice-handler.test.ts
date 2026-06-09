import type { Bot, Context } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../src/core/deps.js";

vi.mock("../src/core/transcriber.js", () => ({
  transcribeOgg: vi.fn(),
}));

vi.mock("../src/shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createReplyTargetMap } from "../src/adapters/telegram/reply-target.js";
import { registerVoiceHandler } from "../src/adapters/telegram/voice-handler.js";
import { transcribeOgg } from "../src/core/transcriber.js";

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
    const mockBot = { on: vi.fn() } as unknown as Bot;
    const mockCtx = createMockVoiceContext();

    let capturedHandler: any;
    (mockBot.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: any) => {
      if (event === "message:voice") capturedHandler = handler;
    });

    (transcribeOgg as ReturnType<typeof vi.fn>).mockResolvedValue("hello world");

    registerVoiceHandler(mockBot, deps, rt);
    await capturedHandler(mockCtx);

    expect(mockCtx.getFile).toHaveBeenCalled();
    expect(transcribeOgg).toHaveBeenCalledWith("/tmp/test.ogg");
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
    const mockBot = { on: vi.fn() } as unknown as Bot;
    const mockCtx = createMockVoiceContext();

    let capturedHandler: any;
    (mockBot.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: any) => {
      if (event === "message:voice") capturedHandler = handler;
    });

    (transcribeOgg as ReturnType<typeof vi.fn>).mockResolvedValue("hello world");

    registerVoiceHandler(mockBot, deps, rt);
    await capturedHandler(mockCtx);

    // The confirmation reply message_id is 888
    expect(rt.resolveReplyTarget(888)).toBe("tmux_proj_test");
  });
});
