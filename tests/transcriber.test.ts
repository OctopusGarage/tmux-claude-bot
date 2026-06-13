import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// transcriber uses promisify(execFile); mock execFile as a callback-style fn.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _bin: string,
      _args: string[],
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: "", stderr: "" }),
  ),
}));

// transcribeWithCache's cache layer — mocked so the orchestration is driven by
// the test (the disk cache itself is media-cache's own concern).
vi.mock("../src/shared/utils/media-cache.js", () => ({
  getFromCache: vi.fn(),
  saveToCache: vi.fn(),
}));

import { execFile } from "node:child_process";
import {
  DEFAULT_WHISPER_MODEL,
  transcribeOgg,
  transcribeWithCache,
} from "../src/core/transcriber.js";
import { getFromCache, saveToCache } from "../src/shared/utils/media-cache.js";

const TMP = os.tmpdir();
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockGetFromCache = getFromCache as unknown as ReturnType<typeof vi.fn>;
const mockSaveToCache = saveToCache as unknown as ReturnType<typeof vi.fn>;

describe("transcribeOgg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MLX_WHISPER_BIN = "mlx_whisper";
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], cb: (e: Error | null, o: unknown) => void) =>
        cb(null, { stdout: "", stderr: "" }),
    );
  });

  afterAll(() => {
    delete process.env.MLX_WHISPER_BIN;
  });

  it("throws when MLX_WHISPER_BIN is not configured", async () => {
    delete process.env.MLX_WHISPER_BIN;
    await expect(transcribeOgg("/tmp/whatever.ogg")).rejects.toThrow("MLX_WHISPER_BIN");
  });

  it("invokes mlx_whisper with an arg vector (no shell) and returns the text", async () => {
    const ogg = nodePath.join(TMP, "test_voice.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, "test_voice.txt"), "test transcription output");

    const result = await transcribeOgg(ogg);

    expect(mockExecFile).toHaveBeenCalledWith(
      "mlx_whisper",
      [ogg, "--model", DEFAULT_WHISPER_MODEL, "--output-format", "txt", "--output-dir", TMP],
      expect.any(Function),
    );
    expect(result).toBe("test transcription output");
  });

  it("passes --language as separate argv entries when a language is given", async () => {
    const ogg = nodePath.join(TMP, "test_voice_lang.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, "test_voice_lang.txt"), "你好");

    await transcribeOgg(ogg, "mlx_whisper", "zh");

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      ogg,
      "--model",
      DEFAULT_WHISPER_MODEL,
      "--output-format",
      "txt",
      "--output-dir",
      TMP,
      "--language",
      "zh",
    ]);
  });

  it("omits --language for auto", async () => {
    const ogg = nodePath.join(TMP, "test_voice_auto.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, "test_voice_auto.txt"), "hi");

    await transcribeOgg(ogg, "mlx_whisper", "auto");

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--language");
  });

  it("treats a path with shell metacharacters as a single argv entry (no injection)", async () => {
    // A path containing ; $() spaces must be one argument, not interpolated into a shell.
    const evil = nodePath.join(TMP, "voice; touch pwned $(id).ogg");
    fs.writeFileSync(evil, "fake");
    fs.writeFileSync(nodePath.join(TMP, "voice; touch pwned $(id).txt"), "safe");

    await transcribeOgg(evil);

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe(evil); // verbatim, one element — not split or expanded
  });

  it("throws on mlx_whisper failure", async () => {
    const ogg = nodePath.join(TMP, "test_voice_fail.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    mockExecFile.mockImplementationOnce(
      (_bin: string, _args: string[], cb: (e: Error | null) => void) =>
        cb(new Error("whisper failed")),
    );
    await expect(transcribeOgg(ogg)).rejects.toThrow("whisper failed");
  });

  it("retries with auto-detect when a forced language yields no output (model lacks e.g. yue)", async () => {
    // mlx_whisper exits 0 but writes no txt when the forced --language is
    // unsupported by the installed model (tiny has no "yue" → ValueError). The
    // bad language code must degrade to auto-detect, not hard-fail.
    const ogg = nodePath.join(TMP, "twc_yue_retry.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    const txt = nodePath.join(TMP, "twc_yue_retry.txt");
    if (fs.existsSync(txt)) fs.unlinkSync(txt);
    mockExecFile.mockImplementation(
      (_bin: string, args: string[], cb: (e: Error | null, o: unknown) => void) => {
        if (args.includes("--language")) {
          // forced language → model can't honor it: exit 0, no txt, ValueError in stderr
          cb(null, { stdout: "", stderr: "ValueError: tuple.index(x): x not in tuple\nSkipping" });
        } else {
          fs.writeFileSync(txt, "你好"); // auto-detect retry succeeds
          cb(null, { stdout: "", stderr: "" });
        }
      },
    );

    const result = await transcribeOgg(ogg, "mlx_whisper", "yue");

    expect(result).toBe("你好");
    expect(mockExecFile.mock.calls[0]?.[1]).toContain("--language"); // first: forced yue
    expect(mockExecFile.mock.calls[1]?.[1]).not.toContain("--language"); // retry: auto
  });

  it("with noFallback, a forced-language failure throws immediately — no auto-detect retry", async () => {
    // The install smoke test relies on this strict mode: a model that can't do the
    // forced language must be REPORTED, not silently downgraded to auto.
    const ogg = nodePath.join(TMP, "twc_nofb.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    const txt = nodePath.join(TMP, "twc_nofb.txt");
    if (fs.existsSync(txt)) fs.unlinkSync(txt);
    mockExecFile.mockImplementation(
      (_b: string, _a: string[], cb: (e: Error | null, o: unknown) => void) =>
        cb(null, { stdout: "", stderr: "ValueError: tuple.index" }),
    );

    await expect(transcribeOgg(ogg, "mlx_whisper", "yue", { noFallback: true })).rejects.toThrow(
      /no output/,
    );
    expect(mockExecFile).toHaveBeenCalledTimes(1); // NOT retried — strict verdict
  });

  it("throws with whisper's own error text when no output is produced at all", async () => {
    // Regression: this used to throw a bare "output not found", discarding the
    // stderr that explains WHY — which is exactly why the yue failure was
    // un-diagnosable in the logs.
    const ogg = nodePath.join(TMP, "twc_noout.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    const txt = nodePath.join(TMP, "twc_noout.txt");
    if (fs.existsSync(txt)) fs.unlinkSync(txt);
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], cb: (e: Error | null, o: unknown) => void) =>
        cb(null, { stdout: "", stderr: "Skipping /x due to ValueError: boom-detail" }),
    );

    await expect(transcribeOgg(ogg, "mlx_whisper", "auto")).rejects.toThrow(/boom-detail/);
  });
});

describe("transcribeWithCache", () => {
  // Stage a real .ogg + its mlx_whisper .txt output so the (real, in-module)
  // transcribeOgg succeeds; execFile is the no-op mock above.
  const stageAudio = (name: string, text: string): string => {
    const ogg = nodePath.join(TMP, `${name}.ogg`);
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, `${name}.txt`), text);
    return ogg;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation(
      (_bin: string, _args: string[], cb: (e: Error | null, o: unknown) => void) =>
        cb(null, { stdout: "", stderr: "" }),
    );
    mockSaveToCache.mockImplementation((_k: string, src: string) => src);
  });

  const base = { label: "t", cacheKey: "k", bin: "mlx_whisper", language: "auto" as const };

  it("cache hit → skips download, transcribes the cached path", async () => {
    const cached = stageAudio("twc_hit", "from cache");
    mockGetFromCache.mockReturnValue(cached);
    const download = vi.fn();

    const res = await transcribeWithCache({ ...base, tmpPath: "/tmp/unused.ogg", download });

    expect(download).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: true, text: "from cache" });
  });

  it("cache miss → downloads, caches, transcribes the cached path", async () => {
    mockGetFromCache.mockReturnValue(null);
    const cached = stageAudio("twc_cached", "hello");
    mockSaveToCache.mockReturnValue(cached);
    const tmpPath = nodePath.join(TMP, "twc_tmp.ogg");
    const download = vi.fn(async (p: string) => fs.writeFileSync(p, "dl"));

    const res = await transcribeWithCache({ ...base, tmpPath, download });

    expect(download).toHaveBeenCalledWith(tmpPath);
    expect(mockSaveToCache).toHaveBeenCalledWith("k", tmpPath);
    expect(res).toEqual({ ok: true, text: "hello" });
  });

  it("download keeps failing → retried (2x), returns reason 'download'", async () => {
    mockGetFromCache.mockReturnValue(null);
    const download = vi.fn().mockRejectedValue(new Error("net"));

    const res = await transcribeWithCache({ ...base, tmpPath: "/tmp/twc_x.ogg", download });

    expect(download).toHaveBeenCalledTimes(2); // withRetry: 1 retry
    expect(res).toEqual({ ok: false, reason: "download" });
  });

  it("transcription throws → returns reason 'transcribe'", async () => {
    mockGetFromCache.mockReturnValue(null);
    const tmpPath = nodePath.join(TMP, "twc_tfail.ogg");
    mockSaveToCache.mockReturnValue(tmpPath);
    const download = vi.fn(async (p: string) => fs.writeFileSync(p, "dl"));
    mockExecFile.mockImplementationOnce((_b: string, _a: string[], cb: (e: Error | null) => void) =>
      cb(new Error("whisper boom")),
    );

    const res = await transcribeWithCache({ ...base, tmpPath, download });

    expect(res).toEqual({ ok: false, reason: "transcribe" });
  });

  it("blank transcription → returns reason 'empty'", async () => {
    mockGetFromCache.mockReturnValue(null);
    const cached = stageAudio("twc_empty", "   ");
    mockSaveToCache.mockReturnValue(cached);
    const download = vi.fn(async (p: string) => fs.writeFileSync(p, "dl"));

    const res = await transcribeWithCache({
      ...base,
      tmpPath: nodePath.join(TMP, "twc_empty_tmp.ogg"),
      download,
    });

    expect(res).toEqual({ ok: false, reason: "empty" });
  });
});
