import type { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPromptTranslateCommand,
  canImportArgosTranslate,
  checkPromptTranslateSupport,
  installPromptTranslation,
  resolvePromptTranslateConfig,
  transformPrompt,
  translateWithArgos,
} from "../src/core/read/prompt-translation.js";

const ENV_KEYS = [
  "PROMPT_TRANSLATE_MODE",
  "PROMPT_TRANSLATE_FROM",
  "PROMPT_TRANSLATE_TO",
  "PROMPT_TRANSLATE_TIMEOUT_MS",
  "TELEGRAM_PROMPT_TRANSLATE_MODE",
  "TELEGRAM_PROMPT_TRANSLATE_FROM",
  "TELEGRAM_PROMPT_TRANSLATE_TO",
  "LARK_PROMPT_TRANSLATE_MODE",
  "LARK_PROMPT_TRANSLATE_FROM",
  "LARK_PROMPT_TRANSLATE_TO",
  "CONTROL_PROMPT_TRANSLATE_MODE",
  "CONTROL_PROMPT_TRANSLATE_FROM",
  "CONTROL_PROMPT_TRANSLATE_TO",
  "VOICE_TRANSLATE_MODE",
  "VOICE_TRANSLATE_FROM",
  "VOICE_TRANSLATE_TO",
  "VOICE_TRANSLATE_TIMEOUT_MS",
  "TELEGRAM_VOICE_TRANSLATE_MODE",
  "TELEGRAM_VOICE_TRANSLATE_FROM",
  "TELEGRAM_VOICE_TRANSLATE_TO",
  "LARK_VOICE_TRANSLATE_MODE",
  "LARK_VOICE_TRANSLATE_FROM",
  "LARK_VOICE_TRANSLATE_TO",
  "ARGOS_TRANSLATE_PYTHON",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("installPromptTranslation", () => {
  it("runs the installer once, smoke-tests Argos, and persists the venv python", async () => {
    const runInstall = vi.fn(async () => {});
    const smokeTest = vi.fn(async () => {});

    const result = await installPromptTranslation({
      checkReady: () => false,
      runInstall,
      smokeTest,
    });

    expect(result).toMatchObject({ status: "ok" });
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(smokeTest).toHaveBeenCalledTimes(1);
    expect(process.env.ARGOS_TRANSLATE_PYTHON).toContain(".venv/bin/python");
  });

  it("reports an install already in progress instead of running two installers", async () => {
    let release!: () => void;
    const firstInstall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runInstall = vi.fn(() => firstInstall);
    const smokeTest = vi.fn(async () => {});

    const first = installPromptTranslation({ checkReady: () => false, runInstall, smokeTest });
    const second = await installPromptTranslation({
      checkReady: () => false,
      runInstall,
      smokeTest,
    });
    release();
    await first;

    expect(second).toEqual({ status: "in-progress" });
    expect(runInstall).toHaveBeenCalledTimes(1);
  });

  it("returns already-ready when the existing Argos install passes the smoke test", async () => {
    const runInstall = vi.fn(async () => {});
    const smokeTest = vi.fn(async () => {});

    const result = await installPromptTranslation({
      checkReady: () => true,
      runInstall,
      smokeTest,
    });

    expect(result).toEqual({ status: "already-ready" });
    expect(runInstall).not.toHaveBeenCalled();
    expect(smokeTest).toHaveBeenCalledTimes(1);
  });
});

describe("prompt translation readiness", () => {
  it("treats a missing argostranslate module as not ready even when python exists", () => {
    process.env.ARGOS_TRANSLATE_PYTHON = process.execPath;
    const ready = checkPromptTranslateSupport({
      canImport: () => false,
    });

    expect(ready).toEqual({ ready: false });
  });

  it("treats a python environment that can import argostranslate as ready", () => {
    process.env.ARGOS_TRANSLATE_PYTHON = process.execPath;
    const ready = checkPromptTranslateSupport({
      canImport: () => true,
    });

    expect(ready.ready).toBe(true);
  });

  it("probes argostranslate importability with the configured python executable", () => {
    const run = vi.fn(() => Buffer.from("")) as unknown as typeof execFileSync;

    expect(canImportArgosTranslate("/opt/tcb/.venv/bin/python", { run })).toBe(true);
    expect(run).toHaveBeenCalledWith("/opt/tcb/.venv/bin/python", ["-c", "import argostranslate"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
  });

  it("fails fast with an install hint when argostranslate is missing", async () => {
    process.env.ARGOS_TRANSLATE_PYTHON = "/opt/tcb/.venv/bin/python";

    await expect(
      translateWithArgos(
        "你好",
        { from: "zh", to: "en", timeoutMs: 1000 },
        { canImport: () => false },
      ),
    ).rejects.toThrow("run npm run translate:install");
  });
});

describe("transformPrompt", () => {
  it("keeps the prompt unchanged when prompt translation is off", async () => {
    const translate = vi.fn(async () => "Ship the feature");

    const result = await transformPrompt("telegram", "把功能做完", { translate });

    expect(result).toEqual({
      ok: true,
      original: "把功能做完",
      prompt: "把功能做完",
      translated: false,
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it("preserves prompt whitespace when translation is off", async () => {
    const result = await transformPrompt("control", "  /debug raw  ");

    expect(result).toEqual({
      ok: true,
      original: "  /debug raw  ",
      prompt: "  /debug raw  ",
      translated: false,
    });
  });

  it("translates Chinese text to an English prompt in prompt argos mode", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    const translate = vi.fn(async () => "Ship the feature");

    const result = await transformPrompt("telegram", "把功能做完", { translate });

    expect(result).toEqual({
      ok: true,
      original: "把功能做完",
      prompt: "Ship the feature",
      translated: true,
    });
    expect(translate).toHaveBeenCalledWith("把功能做完", {
      from: "zh",
      to: "en",
      timeoutMs: 15000,
    });
  });

  it("supports configurable language pair and timeout", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    process.env.PROMPT_TRANSLATE_FROM = "ja";
    process.env.PROMPT_TRANSLATE_TO = "en";
    process.env.PROMPT_TRANSLATE_TIMEOUT_MS = "7000";
    const translate = vi.fn(async () => "Open settings");

    const result = await transformPrompt("telegram", "設定を開いて", { translate });

    expect(result).toMatchObject({
      ok: true,
      original: "設定を開いて",
      prompt: "Open settings",
      translated: true,
    });
    expect(translate).toHaveBeenCalledWith("設定を開いて", {
      from: "ja",
      to: "en",
      timeoutMs: 7000,
    });
  });

  it("resolves per-channel language pair before the shared language pair", () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    process.env.PROMPT_TRANSLATE_FROM = "ja";
    process.env.PROMPT_TRANSLATE_TO = "en";
    process.env.TELEGRAM_PROMPT_TRANSLATE_FROM = "zh";
    process.env.TELEGRAM_PROMPT_TRANSLATE_TO = "en";

    expect(resolvePromptTranslateConfig("telegram")).toEqual({
      enabled: true,
      backend: "argos",
      from: "zh",
      to: "en",
      timeoutMs: 15000,
    });
  });

  it("uses the channel-specific mode before the shared mode", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "off";
    process.env.LARK_PROMPT_TRANSLATE_MODE = "argos";
    const translate = vi.fn(async () => "Open the dashboard");

    const result = await transformPrompt("lark", "打开仪表盘", { translate });

    expect(result).toMatchObject({
      ok: true,
      prompt: "Open the dashboard",
      translated: true,
    });
  });

  it("resolves control-specific prompt translation config before shared config", () => {
    process.env.PROMPT_TRANSLATE_MODE = "off";
    process.env.CONTROL_PROMPT_TRANSLATE_MODE = "argos";
    process.env.CONTROL_PROMPT_TRANSLATE_FROM = "zh";
    process.env.CONTROL_PROMPT_TRANSLATE_TO = "en";

    expect(resolvePromptTranslateConfig("control")).toEqual({
      enabled: true,
      backend: "argos",
      from: "zh",
      to: "en",
      timeoutMs: 15000,
    });
  });

  it("enables prompt translation only after the provider health check succeeds", async () => {
    const translate = vi.fn(async () => "hello");

    const result = await applyPromptTranslateCommand("control", "on zh en", { translate });

    expect(result).toMatchObject({
      ok: true,
      kind: "enabled",
      source: "control",
      mode: "argos",
      from: "zh",
      to: "en",
    });
    expect(translate).toHaveBeenCalledWith("你好", {
      from: "zh",
      to: "en",
      timeoutMs: 15000,
    });
    expect(process.env.CONTROL_PROMPT_TRANSLATE_MODE).toBe("argos");
    expect(process.env.CONTROL_PROMPT_TRANSLATE_FROM).toBe("zh");
    expect(process.env.CONTROL_PROMPT_TRANSLATE_TO).toBe("en");
  });

  it("does not persist prompt translation config when provider health fails", async () => {
    const translate = vi.fn(async () => {
      throw new Error("model missing");
    });

    const result = await applyPromptTranslateCommand("telegram", "on zh en", { translate });

    expect(result).toMatchObject({ ok: false, kind: "unavailable" });
    expect(process.env.TELEGRAM_PROMPT_TRANSLATE_MODE).toBeUndefined();
    expect(process.env.TELEGRAM_PROMPT_TRANSLATE_FROM).toBeUndefined();
    expect(process.env.TELEGRAM_PROMPT_TRANSLATE_TO).toBeUndefined();
  });

  it("reuses saved source language pair when re-enabling after off", async () => {
    process.env.CONTROL_PROMPT_TRANSLATE_MODE = "off";
    process.env.CONTROL_PROMPT_TRANSLATE_FROM = "ja";
    process.env.CONTROL_PROMPT_TRANSLATE_TO = "en";
    const translate = vi.fn(async () => "hello");

    const result = await applyPromptTranslateCommand("control", "on", { translate });

    expect(result).toMatchObject({ ok: true, kind: "enabled", from: "ja", to: "en" });
    expect(translate).toHaveBeenCalledWith("hello", {
      from: "ja",
      to: "en",
      timeoutMs: 15000,
    });
  });

  it("treats unknown modes as off", () => {
    process.env.PROMPT_TRANSLATE_MODE = "bogus";

    expect(resolvePromptTranslateConfig("telegram")).toEqual({ enabled: false, backend: "off" });
  });

  it("keeps the voice env names as legacy aliases", () => {
    process.env.VOICE_TRANSLATE_MODE = "argos_zh_en";

    expect(resolvePromptTranslateConfig("telegram")).toEqual({
      enabled: true,
      backend: "argos",
      from: "zh",
      to: "en",
      timeoutMs: 15000,
    });
  });

  it("returns a translation failure instead of falling back to the Chinese prompt", async () => {
    process.env.PROMPT_TRANSLATE_MODE = "argos";
    const translate = vi.fn(async () => {
      throw new Error("argos missing");
    });

    const result = await transformPrompt("telegram", "把功能做完", { translate });

    expect(result).toEqual({ ok: false, reason: "translate", original: "把功能做完" });
  });
});
