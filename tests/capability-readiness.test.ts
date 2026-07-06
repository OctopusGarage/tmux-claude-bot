import { describe, expect, it } from "vitest";
import {
  promptTranslationReadiness,
  voiceTranscriptionReadiness,
} from "../src/core/read/capability-readiness.js";

describe("capability readiness", () => {
  it("uses one prompt translation path rule for runtime and doctor probes", () => {
    const ready = promptTranslationReadiness({
      env: { ARGOS_TRANSLATE_PYTHON: "/opt/argos/python" },
      fallbackPython: "/repo/.venv/bin/python",
      probes: { pathExists: (p) => p === "/opt/argos/python", pathExecutable: () => true },
    });

    expect(ready).toEqual({ status: "ready", python: "/opt/argos/python" });
  });

  it("falls back to the managed Argos venv only when an explicit path is stale", () => {
    const readiness = promptTranslationReadiness({
      env: { ARGOS_TRANSLATE_PYTHON: "/stale/python" },
      fallbackPython: "/repo/.venv/bin/python",
      probes: { pathExists: (p) => p === "/repo/.venv/bin/python", pathExecutable: () => true },
    });

    expect(readiness).toEqual({ status: "ready", python: "/repo/.venv/bin/python" });
  });

  it("reports a non-executable Argos python distinctly from a missing path", () => {
    const readiness = promptTranslationReadiness({
      env: { ARGOS_TRANSLATE_PYTHON: "/opt/argos/python" },
      fallbackPython: "/repo/.venv/bin/python",
      probes: { pathExists: () => true, pathExecutable: () => false },
    });

    expect(readiness).toEqual({
      status: "not-executable",
      python: "/opt/argos/python",
    });
  });

  it("keeps voice platform support and binary readiness in one report", () => {
    const missing = voiceTranscriptionReadiness({
      env: { MLX_WHISPER_BIN: "/missing/mlx_whisper" },
      fallbackBin: "/repo/.venv/bin/mlx_whisper",
      platformSupported: true,
      probes: { pathExists: () => false, pathExecutable: () => false },
    });
    const unsupported = voiceTranscriptionReadiness({
      env: {},
      fallbackBin: "/repo/.venv/bin/mlx_whisper",
      platformSupported: false,
      probes: { pathExists: () => false, pathExecutable: () => false },
    });

    expect(missing).toEqual({ status: "missing", bin: "/repo/.venv/bin/mlx_whisper" });
    expect(unsupported).toEqual({
      status: "unsupported-platform",
      bin: "/repo/.venv/bin/mlx_whisper",
    });
  });
});
