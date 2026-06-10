import type { NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeChannel, fakeDeps, fakeMessage } from "./_fakes.js";

// Control the whisper core: voice readiness, language, and the transcription;
// and the Feishu message-resource download (no real network).
const checkVoiceSupport = vi.fn();
const resolveWhisperLanguage = vi.fn(() => "en");
const transcribeOgg = vi.fn();
const downloadMessageResource = vi.fn();

vi.mock("../../../src/core/voice-support.js", () => ({
  checkVoiceSupport: () => checkVoiceSupport(),
  resolveWhisperLanguage: () => resolveWhisperLanguage(),
}));
vi.mock("../../../src/core/transcriber.js", () => ({
  transcribeOgg: (...args: unknown[]) => transcribeOgg(...args),
}));
vi.mock("../../../src/adapters/lark/resource.js", () => ({
  downloadMessageResource: (...args: unknown[]) => downloadMessageResource(...args),
}));

// Imported AFTER the mocks are registered.
const { handleLarkVoice } = await import("../../../src/adapters/lark/voice.js");

const audio: ResourceDescriptor = { type: "audio", fileKey: "fk-1" };
const msg = (): NormalizedMessage =>
  fakeMessage({ rawContentType: "audio", content: "", resources: [audio] });

describe("handleLarkVoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWhisperLanguage.mockReturnValue("en");
    downloadMessageResource.mockResolvedValue(undefined);
  });

  it("voice support not ready → hint reply, no transcription", async () => {
    checkVoiceSupport.mockReturnValue({ ready: false, reason: "not-installed" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(transcribeOgg).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("语音转写未安装"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("unsupported platform → the Apple Silicon hint", async () => {
    checkVoiceSupport.mockReturnValue({ ready: false, reason: "unsupported-platform" });
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("Apple Silicon"))).toBe(true);
  });

  it("success → echoes the transcription then enqueues the text", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    transcribeOgg.mockResolvedValue("hello world");
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio, "proj-override");

    expect(channel.texts().some((t) => t.includes("🎙️ 你说的是：「hello world」"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.action).toBe("text");
    expect(deps.queue.enqueued[0]?.text).toBe("hello world");
    expect(deps.queue.enqueued[0]?.sessionName).toBe("proj-override");
  });

  it("download keeps failing (after retry) → distinct download-failed reply, no transcribe", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    downloadMessageResource.mockRejectedValue(new Error("Request failed with status code 400"));
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(downloadMessageResource).toHaveBeenCalledTimes(2); // retried once
    expect(transcribeOgg).not.toHaveBeenCalled();
    expect(channel.texts().some((t) => t.includes("下载失败"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("download fails once then succeeds (retry) → transcribes and enqueues", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    downloadMessageResource
      .mockRejectedValueOnce(new Error("transient 400"))
      .mockResolvedValue(undefined);
    transcribeOgg.mockResolvedValue("recovered");
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(downloadMessageResource).toHaveBeenCalledTimes(2);
    expect(deps.queue.enqueued).toHaveLength(1);
    expect(deps.queue.enqueued[0]?.text).toBe("recovered");
  });

  it("downloads via messageResource with the message_id (not file.get)", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    transcribeOgg.mockResolvedValue("ok");
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(
      channel,
      deps,
      fakeMessage({ messageId: "om_123", resources: [audio] }),
      audio,
    );

    expect(downloadMessageResource).toHaveBeenCalledWith(
      expect.anything(),
      "om_123",
      "fk-1",
      expect.stringContaining("/tmp/lark_voice_"),
    );
  });

  it("transcription error → 转写失败 reply, no enqueue", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    transcribeOgg.mockRejectedValue(new Error("whisper boom"));
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("转写失败"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });

  it("empty transcription → didn't-catch reply, no enqueue", async () => {
    checkVoiceSupport.mockReturnValue({ ready: true, bin: "/bin/whisper" });
    transcribeOgg.mockResolvedValue("   ");
    const channel = fakeChannel();
    const deps = fakeDeps();

    await handleLarkVoice(channel, deps, msg(), audio);

    expect(channel.texts().some((t) => t.includes("没听清"))).toBe(true);
    expect(deps.queue.enqueued).toHaveLength(0);
  });
});
