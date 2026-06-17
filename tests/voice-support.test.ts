import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node:os is mocked so platform/arch can be forced; everything else (tmpdir, …)
// delegates to the real implementation.
vi.mock("node:os", async (importActual) => {
  const actual = await importActual<typeof import("node:os")>();
  return { ...actual, platform: vi.fn(actual.platform), arch: vi.fn(actual.arch) };
});

// existsSync delegates to the real fs by default (so real temp files resolve),
// but can be forced false to simulate "nothing installed" deterministically —
// the project venv (WHISPER_VENV_BIN) is frozen to cwd/.venv at import, which
// may exist on a dev box that ran the installer.
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), accessSync: vi.fn(actual.accessSync) };
});

// installVoice runs the install script via execFile — mock it so no real
// install happens; each test drives the callback (success/failure).
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

// persistWhisperBin writes .env via env-store; stub it (no real file in tests).
vi.mock("../src/core/infra/env-store.js", () => ({ persistEnvVar: vi.fn() }));

import { execFile } from "node:child_process";
import * as os from "node:os";
import {
  checkVoiceSupport,
  configuredWhisperLanguages,
  installVoice,
  resolveWhisperBin,
  resolveWhisperLanguage,
} from "../src/core/read/voice-support.js";

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

describe("configuredWhisperLanguages", () => {
  const KEYS = ["WHISPER_LANGUAGE", "TELEGRAM_WHISPER_LANGUAGE", "LARK_WHISPER_LANGUAGE"];
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("returns the distinct set actually configured across channels (what a smoke test must prove)", () => {
    process.env.TELEGRAM_WHISPER_LANGUAGE = "yue";
    process.env.LARK_WHISPER_LANGUAGE = "yue";
    process.env.WHISPER_LANGUAGE = "zh";
    expect([...configuredWhisperLanguages()].sort()).toEqual(["yue", "zh"]);
  });

  it("excludes auto and falls back to the default when nothing concrete is set", () => {
    process.env.WHISPER_LANGUAGE = "auto";
    expect(configuredWhisperLanguages()).toEqual(["zh"]); // DEFAULT_WHISPER_LANGUAGE
  });
});

describe("resolveWhisperBin", () => {
  let realBin: string;

  beforeEach(() => {
    realBin = nodePath.join(os.tmpdir(), `fake_mlx_whisper_resolve_${process.pid}`);
    fs.writeFileSync(realBin, "#!/bin/sh\n", { mode: 0o755 });
  });

  afterEach(() => {
    delete process.env.MLX_WHISPER_BIN;
    try {
      fs.unlinkSync(realBin);
    } catch {
      /* best effort */
    }
  });

  it("prefers an explicit MLX_WHISPER_BIN that exists", () => {
    process.env.MLX_WHISPER_BIN = realBin;
    expect(resolveWhisperBin()).toBe(realBin);
  });

  it("ignores a stale explicit path and falls back to the venv when it doesn't exist", () => {
    // The dev-mode footgun: prod's .env points MLX_WHISPER_BIN at a venv that
    // isn't there, masking the freshly-installed project venv.
    process.env.MLX_WHISPER_BIN = "/nope/does/not/exist/mlx_whisper";
    expect(resolveWhisperBin()).toContain(nodePath.join(".venv", "bin", "mlx_whisper"));
  });

  it("falls back to the project-managed venv path when unset", () => {
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
    asMock(fs.existsSync).mockReturnValue(false); // neither explicit nor venv present
    expect(checkVoiceSupport()).toEqual({ ready: false, reason: "not-installed" });
  });

  it("flags unsupported platforms when not on Apple Silicon", () => {
    process.env.MLX_WHISPER_BIN = "/nope/does/not/exist";
    asMock(fs.existsSync).mockReturnValue(false);
    asMock(os.platform).mockReturnValue("linux");
    asMock(os.arch).mockReturnValue("x64");
    expect(checkVoiceSupport()).toEqual({ ready: false, reason: "unsupported-platform" });
  });
});

describe("installVoice", () => {
  const onArm64 = () => {
    asMock(os.platform).mockReturnValue("darwin");
    asMock(os.arch).mockReturnValue("arm64");
  };

  afterEach(() => {
    delete process.env.MLX_WHISPER_BIN;
    vi.restoreAllMocks();
  });

  it("returns already-ready (after the smoke test passes) without running the script", async () => {
    onArm64();
    asMock(fs.existsSync).mockReturnValue(true);
    asMock(fs.accessSync).mockReturnValue(undefined); // executable
    const smokeTest = vi.fn(async () => {});
    expect(await installVoice({ smokeTest })).toEqual({ status: "already-ready" });
    expect(smokeTest).toHaveBeenCalledTimes(1); // existence alone is not enough
    expect(execFile).not.toHaveBeenCalled();
  });

  it("reports failed when the binary exists but the smoke test fails (e.g. model can't do yue)", async () => {
    // The exact gap the user hit: voice looked 'installed' (binary present) so the
    // old check said ready, while every Cantonese message crashed. The smoke test
    // must turn that into an honest failure.
    onArm64();
    asMock(fs.existsSync).mockReturnValue(true);
    asMock(fs.accessSync).mockReturnValue(undefined);
    const smokeTest = vi.fn(async () => {
      throw new Error("ValueError: tuple.index(x): x not in tuple");
    });
    const result = await installVoice({ smokeTest });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("tuple.index");
    expect(execFile).not.toHaveBeenCalled(); // never even ran the installer
  });

  it("returns unsupported on a non-Apple-Silicon host", async () => {
    asMock(os.platform).mockReturnValue("linux");
    asMock(os.arch).mockReturnValue("x64");
    asMock(fs.existsSync).mockReturnValue(false);
    expect(await installVoice()).toEqual({ status: "unsupported" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs the script and reports ok when the binary appears and the smoke test passes", async () => {
    onArm64();
    let installed = false;
    asMock(fs.existsSync).mockImplementation(() => installed);
    asMock(fs.accessSync).mockReturnValue(undefined);
    asMock(execFile).mockImplementation((...args: unknown[]) => {
      installed = true; // the script "produced" the binary
      (args[args.length - 1] as (e: unknown) => void)(null);
    });
    const smokeTest = vi.fn(async () => {});
    const result = await installVoice({ smokeTest });
    expect(execFile).toHaveBeenCalled();
    expect(smokeTest).toHaveBeenCalledTimes(1); // verified end-to-end before "ok"
    expect(result.status, JSON.stringify(result)).toBe("ok");
  });

  it("reports failed when the freshly-installed binary can't transcribe (smoke test throws)", async () => {
    onArm64();
    let installed = false;
    asMock(fs.existsSync).mockImplementation(() => installed);
    asMock(fs.accessSync).mockReturnValue(undefined);
    asMock(execFile).mockImplementation((...args: unknown[]) => {
      installed = true;
      (args[args.length - 1] as (e: unknown) => void)(null);
    });
    const smokeTest = vi.fn(async () => {
      throw new Error("Transcription produced no output — Skipping due to ValueError");
    });
    const result = await installVoice({ smokeTest });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("no output");
  });

  it("reports failed (not a throw) when the script errors", async () => {
    onArm64();
    asMock(fs.existsSync).mockReturnValue(false);
    asMock(execFile).mockImplementation((...args: unknown[]) => {
      (args[args.length - 1] as (e: unknown) => void)(new Error("boom"));
    });
    const result = await installVoice();
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.message).toContain("boom");
  });
});
