import type { NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscribeOutcome } from "../../../src/core/read/transcriber.js";
import { fakeChannel, fakeDeps, fakeMessage } from "./_fakes.js";

// Voice readiness + language, the shared cache-aware transcriber, and the Feishu
// message-resource download are all mocked. The cache/download/retry orchestration
// itself lives in transcribeWithCache and is covered by tests/transcriber.test.ts;
// here we only assert handler gating, outcome mapping, and download-callback wiring.
const checkVoiceSupport = vi.fn();
const resolveWhisperLanguage = vi.fn(() => "en");
const transcribeWithCache = vi.fn();
const downloadMessageResource = vi.fn();

vi.mock("../../../src/core/read/voice-support.js", () => ({
  checkVoiceSupport: () => checkVoiceSupport(),
  resolveWhisperLanguage: () => resolveWhisperLanguage(),
}));
vi.mock(import("../../../src/core/read/transcriber.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeWithCache: (opts: unknown) => transcribeWithCache(opts),
}));
vi.mock("../../../src/adapters/lark/resource.js", () => ({
  downloadMessageResource: (...args: unknown[]) => downloadMessageResource(...args),
}));

// Imported AFTER the mocks are registered.
const { handleLarkVoice } = await import("../../../src/adapters/lark/voice.js");

const audio: ResourceDescriptor = { type: "audio", fileKey: "fk-1" };
const msg = (): NormalizedMessage =>
  fakeMessage({ rawContentType: "audio", content: "", resources: [audio] });

const outcome = (o: TranscribeOutcome) => transcribeWithCache.mockResolvedValue(o);

describe("handleLarkVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWhisperLanguage.mockReturnValue("en");
    downloadMessageResource.mockResolvedValue(undefined);
    outcome({ ok: true, text: "hello world" });
  });

  it("voice support not ready → hint reply, no transcription", async () => {
    checkVoiceSupport.mockReturnValue({ ready: false, reason: "not-installed" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(transcribeWithCache).not.toHaveBeenCalled();
    // Installable → a card with the one-tap install button (not plain text).
    expect(JSON.stringify(channel.cards())).toContain("voiceinstall");
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("unsupported platform → the Apple Silicon hint", async () => {
    checkVoiceSupport.mockReturnValue({ ready: false, reason: "unsupported-platform" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("Apple Silicon"))).toBe(true);
  });

  it("no lark config → download-failed reply without transcribing", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    const channel = fakeChannel();
    const deps = fakeDeps({ config: { lark: undefined as never } });

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(transcribeWithCache).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("下载失败"))).toBe(true);
  });

  it("success → echoes the transcription then enqueues the text", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    outcome({ ok: true, text: "hello world" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio, "proj-override");

    expect(channel.texts().some((t) => t.includes("🎙️ 你说的是：「hello world」"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("text");
    expect(deps.queue.enqueued[0]?.text).toBe("hello world");
    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-override");
  });

  it("passes a lark-scoped cache key, bin/language and tmp path to transcribeWithCache", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(transcribeWithCache).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "lark",
        cacheKey: "lark:fk-1",
        bin: "/bin/whisper",
        language: "en",
        tmpPath: expect.stringContaining("/tmp/lark_voice_"),
      }),
    );
  });

  it("its download callback fetches the message resource by message_id (not file.get)", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(
      channel,
      deps,
      fakeMessage({ messageId: "om_123", resources: [audio] }),
      audio,
    );

    // Invoke the captured download callback to prove its wiring.
    const opts = transcribeWithCache.mock.calls[0]?.[0] as {
      download: (tmp: string) => Promise<void>;
    };
    await opts.download("/tmp/lark_voice_x.opus");
    expect(downloadMessageResource).toHaveBeenCalledWith(
      expect.anything(),
      "om_123",
      "fk-1",
      "/tmp/lark_voice_x.opus",
    );
  });

  it("download outcome → distinct download-failed reply, no enqueue", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    outcome({ ok: false, reason: "download" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("下载失败"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("transcribe outcome → 转写失败 reply, no enqueue", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    outcome({ ok: false, reason: "transcribe" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("转写失败"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("empty outcome → didn't-catch reply, no enqueue", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    outcome({ ok: false, reason: "empty" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("没听清"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });
});
