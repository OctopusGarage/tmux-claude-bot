import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx, fakeDeps } from "./_fakes.js";

// Mock only the output / IO side-effects; let the handler's routing logic run.
vi.mock("../../../src/adapters/telegram/replies.js", () => ({ reply: vi.fn(), send: vi.fn() }));
vi.mock("../../../src/adapters/telegram/prompt-lifecycle.js", () => ({
  runPromptWithProgress: vi.fn(),
}));
// Mock the readiness/IO functions; keep the real data exports (e.g. VOICE_LANGS,
// which buildVoiceLangKeyboard reads) via importOriginal.
vi.mock("../../../src/core/read/voice-support.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/voice-support.js")>()),
  checkVoiceSupport: vi.fn(),
  isVoicePlatformSupported: vi.fn(),
  installVoice: vi.fn(),
  resolveWhisperLanguage: vi.fn(() => "zh"),
  setWhisperLanguage: vi.fn(),
}));
// Keep the real voiceFailMessage (a pure reason→message map); mock the IO half.
vi.mock("../../../src/core/read/transcriber.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/read/transcriber.js")>()),
  transcribeWithCache: vi.fn(),
}));
vi.mock("../../../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import { runPromptWithProgress } from "../../../src/adapters/telegram/prompt-lifecycle.js";
import { reply } from "../../../src/adapters/telegram/replies.js";
import { createReplyTargetMap } from "../../../src/adapters/telegram/reply-target.js";
import { registerVoiceHandler } from "../../../src/adapters/telegram/voice-handler.js";
import { messages } from "../../../src/core/i18n/index.js";
import { transcribeWithCache } from "../../../src/core/read/transcriber.js";
import {
  checkVoiceSupport,
  installVoice,
  isVoicePlatformSupported,
  setWhisperLanguage,
} from "../../../src/core/read/voice-support.js";

const replyMock = reply as ReturnType<typeof vi.fn>;
const promptMock = runPromptWithProgress as ReturnType<typeof vi.fn>;
const checkVoiceSupportMock = checkVoiceSupport as ReturnType<typeof vi.fn>;
const isVoicePlatformSupportedMock = isVoicePlatformSupported as ReturnType<typeof vi.fn>;
const installVoiceMock = installVoice as ReturnType<typeof vi.fn>;
const setWhisperLanguageMock = setWhisperLanguage as ReturnType<typeof vi.fn>;
const transcribeMock = transcribeWithCache as ReturnType<typeof vi.fn>;

const M = messages("telegram");

const replyTarget = createReplyTargetMap(`/tmp/tg-voice-rt-${Date.now()}`);

// Capture the handlers the registration wires up so tests can drive them.
function captureBot() {
  const handlers: Record<string, (ctx: unknown) => unknown> = {};
  const bot = {
    command: (name: string, h: (ctx: unknown) => unknown) => {
      handlers[`cmd:${name}`] = h;
    },
    on: (event: string, h: (ctx: unknown) => unknown) => {
      handlers[`on:${event}`] = h;
    },
  };
  return { bot, handlers };
}

function register(deps: ReturnType<typeof fakeDeps>) {
  const { bot, handlers } = captureBot();
  registerVoiceHandler(
    bot as unknown as Parameters<typeof registerVoiceHandler>[0],
    deps,
    replyTarget,
  );
  return handlers;
}

/** Add a getFile() stub to a fakeCtx (the download-path source). */
function withGetFile(ctx: ReturnType<typeof fakeCtx>, filePath: string | undefined) {
  (ctx as unknown as Record<string, unknown>).getFile = vi.fn(async () => ({
    file_path: filePath,
    download: vi.fn(),
  }));
  return ctx;
}

/** A voice message ctx with the given text/reply-to. */
function voiceCtx(over: { chatId?: number; messageId?: number; replyToMessageId?: number } = {}) {
  const ctx = fakeCtx(over);
  (ctx.message as unknown as Record<string, unknown>).voice = { file_id: "vf_1" };
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  isVoicePlatformSupportedMock.mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

describe("voice_install", () => {
  it("replies already-installed when voice support is ready", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: true, bin: "/bin/mlx" });
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceAlreadyInstalled,
      expect.anything(),
    );
    expect(installVoiceMock).not.toHaveBeenCalled();
  });

  it("replies unsupported when the platform can't run voice", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "unsupported-platform" });
    isVoicePlatformSupportedMock.mockReturnValue(false);
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      M.voiceNeedsAppleSilicon,
      expect.anything(),
    );
    expect(installVoiceMock).not.toHaveBeenCalled();
  });

  it("installs and replies ok on a successful install", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "not-installed" });
    installVoiceMock.mockResolvedValue({ status: "ok", bin: "/bin/mlx" });
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    expect(installVoiceMock).toHaveBeenCalled();
    // "installing…" first, then the ok result.
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceInstalling,
      expect.anything(),
    );
    expect(replyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "info",
      M.voiceInstallOk,
      expect.anything(),
    );
  });

  it("replies install-failed (with the error) when install fails", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "not-installed" });
    installVoiceMock.mockResolvedValue({ status: "failed", message: "boom" });
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    expect(replyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "err",
      M.voiceInstallFailed("boom"),
      expect.anything(),
    );
  });

  it("replies already-installed when install reports already-ready", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "not-installed" });
    installVoiceMock.mockResolvedValue({ status: "already-ready" });
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    expect(replyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "info",
      M.voiceAlreadyInstalled,
      expect.anything(),
    );
  });

  it("replies unsupported when install reports unsupported", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "not-installed" });
    installVoiceMock.mockResolvedValue({ status: "unsupported" });
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    expect(replyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "err",
      M.voiceNeedsAppleSilicon,
      expect.anything(),
    );
  });

  it("replies installing when install reports in-progress", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "not-installed" });
    installVoiceMock.mockResolvedValue({ status: "in-progress" });
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_install"]?.(fakeCtx({ text: "/voice_install" }));

    // both the pre-ack and the in-progress result render "installing…"
    expect(replyMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "info",
      M.voiceInstalling,
      expect.anything(),
    );
  });
});

describe("voice_lang", () => {
  it("with no arg replies the current language plus a picker keyboard", async () => {
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_lang"]?.(fakeCtx({ text: "/voice_lang" }));

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceLangCurrent("zh"),
      expect.objectContaining({ replyMarkup: expect.anything() }),
    );
    expect(setWhisperLanguageMock).not.toHaveBeenCalled();
  });

  it("with an invalid arg replies the usage/invalid message", async () => {
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_lang"]?.(fakeCtx({ text: "/voice_lang 12!" }));

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      M.voiceLangInvalid,
      expect.anything(),
    );
    expect(setWhisperLanguageMock).not.toHaveBeenCalled();
  });

  it("with a valid code sets the language and confirms", async () => {
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_lang"]?.(fakeCtx({ text: "/voice_lang yue" }));

    expect(setWhisperLanguageMock).toHaveBeenCalledWith("telegram", "yue");
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceLangSet("yue"),
      expect.anything(),
    );
  });

  it("accepts 'auto' as a valid language", async () => {
    const handlers = register(fakeDeps());
    await handlers["cmd:voice_lang"]?.(fakeCtx({ text: "/voice_lang auto" }));

    expect(setWhisperLanguageMock).toHaveBeenCalledWith("telegram", "auto");
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceLangSet("auto"),
      expect.anything(),
    );
  });
});

describe("message:voice", () => {
  it("hints not-installed when support isn't ready (installable host)", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "not-installed" });
    const handlers = register(fakeDeps());
    await handlers["on:message:voice"]?.(voiceCtx());

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceNotEnabled,
      expect.anything(),
    );
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("hints unsupported when support fails on platform", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: false, reason: "unsupported-platform" });
    const handlers = register(fakeDeps());
    await handlers["on:message:voice"]?.(voiceCtx());

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceNeedsAppleSilicon,
      expect.anything(),
    );
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("replies download-failed when getFile returns no file_path", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: true, bin: "/bin/mlx" });
    const handlers = register(fakeDeps());
    const ctx = withGetFile(voiceCtx(), undefined);
    await handlers["on:message:voice"]?.(ctx);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      M.voiceDownloadFailed,
      expect.anything(),
    );
    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it("replies the matching fail message when transcription fails", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: true, bin: "/bin/mlx" });
    transcribeMock.mockResolvedValue({ ok: false, reason: "transcribe" });
    const handlers = register(fakeDeps());
    const ctx = withGetFile(voiceCtx(), "voice/file.ogg");
    await handlers["on:message:voice"]?.(ctx);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      M.voiceTranscribeFailed,
      expect.anything(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("replies no-session when nothing resolves a target session", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: true, bin: "/bin/mlx" });
    transcribeMock.mockResolvedValue({ ok: true, text: "hello there" });
    const deps = fakeDeps({ currentProject: { get: vi.fn(async () => null) } });
    const handlers = register(deps);
    const ctx = withGetFile(voiceCtx(), "voice/file.ogg");
    await handlers["on:message:voice"]?.(ctx);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      M.noSession,
      expect.anything(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("replies not-running when the agent is down for the session", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: true, bin: "/bin/mlx" });
    transcribeMock.mockResolvedValue({ ok: true, text: "hello there" });
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => false) } });
    const handlers = register(deps);
    const ctx = withGetFile(voiceCtx(), "voice/file.ogg");
    await handlers["on:message:voice"]?.(ctx);

    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "err",
      M.notRunning,
      expect.anything(),
    );
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("on success records the reply target, confirms, and runs the prompt", async () => {
    checkVoiceSupportMock.mockReturnValue({ ready: true, bin: "/bin/mlx" });
    transcribeMock.mockResolvedValue({ ok: true, text: "build me a thing" });
    const deps = fakeDeps({ agent: { checkIfRunning: vi.fn(async () => true) } });
    const handlers = register(deps);
    const ctx = withGetFile(voiceCtx({ messageId: 42 }), "voice/file.ogg");
    await handlers["on:message:voice"]?.(ctx);

    // voiceHeard confirmation went out with the transcript
    expect(replyMock).toHaveBeenCalledWith(
      expect.anything(),
      "info",
      M.voiceHeard("build me a thing"),
      expect.objectContaining({ session: "proj-1" }),
    );
    // and the prompt was dispatched for the resolved session
    expect(promptMock).toHaveBeenCalledWith(ctx, deps, "proj-1", "build me a thing", replyTarget);
  });
});
