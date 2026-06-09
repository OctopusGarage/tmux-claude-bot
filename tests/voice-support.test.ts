import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node:os is mocked so platform/arch can be forced; everything else (tmpdir, …)
// delegates to the real implementation.
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform), arch: vi.fn(actual.arch) };
});

import * as os from "node:os";
import {
  checkVoiceSupport,
  resolveWhisperBin,
  resolveWhisperLanguage,
} from "../src/core/voice-support.js";

const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe("resolveWhisperLanguage", () => {
  afterEach(() => {
    delete process.env.WHISPER_LANGUAGE;
  });

  it("defaults to zh when unset", () => {
    delete process.env.WHISPER_LANGUAGE;
    expect(resolveWhisperLanguage()).toBe("zh");
  });

  it("honours an explicit WHISPER_LANGUAGE", () => {
    process.env.WHISPER_LANGUAGE = "en";
    expect(resolveWhisperLanguage()).toBe("en");
  });

  it("passes through auto", () => {
    process.env.WHISPER_LANGUAGE = "auto";
    expect(resolveWhisperLanguage()).toBe("auto");
  });
});

describe("resolveWhisperBin", () => {
  afterEach(() => {
    delete process.env.MLX_WHISPER_BIN;
  });

  it("prefers an explicit MLX_WHISPER_BIN", () => {
    process.env.MLX_WHISPER_BIN = "/custom/mlx_whisper";
    expect(resolveWhisperBin()).toBe("/custom/mlx_whisper");
  });

  it("falls back to the project-managed venv path", () => {
    delete process.env.MLX_WHISPER_BIN;
    expect(resolveWhisperBin()).toContain(nodePath.join(".venv", "bin", "mlx_whisper"));
  });
});

describe("checkVoiceSupport", () => {
  let realBin: string;

  beforeEach(() => {
    // A real executable so the "ready" branch is exercisable on any host
    // (mlx-whisper itself is Apple-Silicon only).
    realBin = nodePath.join(os.tmpdir(), `fake_mlx_whisper_${process.pid}`);
    fs.writeFileSync(realBin, "#!/bin/sh\n", { mode: 0o755 });
    asMock(os.platform).mockReturnValue("darwin");
    asMock(os.arch).mockReturnValue("arm64");
  });

  afterEach(() => {
    delete process.env.MLX_WHISPER_BIN;
    vi.restoreAllMocks();
    try {
      fs.unlinkSync(realBin);
    } catch {
      /* best effort */
    }
  });

  it("is ready when the binary exists and is executable", () => {
    process.env.MLX_WHISPER_BIN = realBin;
    expect(checkVoiceSupport()).toEqual({ ready: true, bin: realBin });
  });

  it("reports not-installed when the binary is missing on a supported platform", () => {
    process.env.MLX_WHISPER_BIN = "/nope/does/not/exist";
    expect(checkVoiceSupport()).toEqual({ ready: false, reason: "not-installed" });
  });

  it("flags unsupported platforms when not on Apple Silicon", () => {
    process.env.MLX_WHISPER_BIN = "/nope/does/not/exist";
    asMock(os.platform).mockReturnValue("linux");
    asMock(os.arch).mockReturnValue("x64");
    expect(checkVoiceSupport()).toEqual({ ready: false, reason: "unsupported-platform" });
  });
});
