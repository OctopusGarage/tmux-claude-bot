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

import { execFile } from "node:child_process";
import { transcribeOgg } from "../src/core/transcriber.js";

const TMP = os.tmpdir();
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

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
      [ogg, "--output-format", "txt", "--output-dir", TMP],
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
    expect(args).toEqual([ogg, "--output-format", "txt", "--output-dir", TMP, "--language", "zh"]);
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
});
