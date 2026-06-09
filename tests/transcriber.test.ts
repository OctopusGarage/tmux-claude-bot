import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// transcriber uses promisify(exec); mock exec as a callback-style fn.
vi.mock("node:child_process", () => ({
  exec: vi.fn(
    (_cmd: string, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) =>
      cb(null, { stdout: "", stderr: "" }),
  ),
}));

import { exec } from "node:child_process";
import { transcribeOgg } from "../src/core/transcriber.js";

const TMP = os.tmpdir();

describe("transcribeOgg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MLX_WHISPER_BIN = "mlx_whisper";
    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (_cmd: string, cb: (e: Error | null, o: { stdout: string; stderr: string }) => void) =>
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

  it("calls mlx_whisper and returns the transcribed text", async () => {
    const ogg = nodePath.join(TMP, "test_voice.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, "test_voice.txt"), "test transcription output");

    const result = await transcribeOgg(ogg);

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("test_voice.ogg --output-format txt --output-dir"),
      expect.any(Function),
    );
    expect(result).toBe("test transcription output");
  });

  it("passes --language when a language is given", async () => {
    const ogg = nodePath.join(TMP, "test_voice_lang.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, "test_voice_lang.txt"), "你好");

    await transcribeOgg(ogg, "mlx_whisper", "zh");

    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("--language zh"),
      expect.any(Function),
    );
  });

  it("omits --language for auto", async () => {
    const ogg = nodePath.join(TMP, "test_voice_auto.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    fs.writeFileSync(nodePath.join(TMP, "test_voice_auto.txt"), "hi");

    await transcribeOgg(ogg, "mlx_whisper", "auto");

    expect(exec).toHaveBeenCalledWith(
      expect.not.stringContaining("--language"),
      expect.any(Function),
    );
  });

  it("throws on mlx_whisper failure", async () => {
    const ogg = nodePath.join(TMP, "test_voice_fail.ogg");
    fs.writeFileSync(ogg, "fake ogg data");
    (exec as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_cmd: string, cb: (e: Error | null) => void) => cb(new Error("whisper failed")),
    );
    await expect(transcribeOgg(ogg)).rejects.toThrow("whisper failed");
  });
});
