import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { persistEnvVar } from "../infra/env-store.js";
import type { Channel } from "../projects/project-manager.js";
import { promptTranslationReadiness } from "./capability-readiness.js";

const ROOT = process.cwd();
export const ARGOS_VENV_PYTHON = nodePath.join(ROOT, ".venv", "bin", "python");
export const ARGOS_INSTALL_SCRIPT = nodePath.join(ROOT, "scripts", "install-argos-translate.sh");
export const DEFAULT_PROMPT_TRANSLATE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 300_000;
const execFileAsync = promisify(execFile);

const log = createLogger("read.prompt-translation");

type EnvLike = Record<string, string | undefined>;
export type PromptTransformSource = Channel | "control";
export type PromptTranslateConfig =
  | { enabled: false; backend: "off" }
  | { enabled: true; backend: "argos"; from: string; to: string; timeoutMs: number };

export const PROMPT_TRANSLATE_TARGET_LANGUAGE = "en";
export const PROMPT_TRANSLATE_SOURCE_PRESETS = ["zh", "yue", "ja", "es"] as const;

export type PromptTransformOutcome =
  | { ok: true; original: string; prompt: string; translated: boolean }
  | { ok: false; original: string; reason: "translate" };

export type PreparedUserPrompt =
  | {
      ok: true;
      text: string;
      origin: "user";
      promptSource: PromptTransformSource;
      translated: boolean;
      sourceText?: string | undefined;
      transform?:
        | {
            kind: "translation";
            provider: "argos";
            from: string;
            to: string;
            sourceText: string;
            deliveredText: string;
          }
        | undefined;
    }
  | { ok: false; original: string; reason: "translate" };

export type TranslateText = (
  text: string,
  opts: { from: string; to: string; timeoutMs: number },
) => Promise<string>;

export type PromptTranslateInstallResult =
  | { status: "already-ready" }
  | { status: "in-progress" }
  | { status: "ok"; python: string }
  | { status: "failed"; message: string };

export type PromptTranslateCommandResult =
  | {
      ok: true;
      kind: "status" | "enabled";
      source: PromptTransformSource;
      mode: "argos";
      from: string;
      to: string;
      timeoutMs: number;
    }
  | { ok: true; kind: "status" | "disabled"; source: PromptTransformSource; mode: "off" }
  | { ok: false; kind: "usage"; usage: string }
  | { ok: false; kind: "unavailable"; error: string };

export function promptTranslateSummary(source: PromptTransformSource): string {
  const config = resolvePromptTranslateConfig(source);
  return config.enabled ? `${config.backend} ${config.from}->${config.to}` : "off";
}

export function promptTranslateEnvKeys(source: PromptTransformSource): {
  mode: string;
  from: string;
  to: string;
} {
  return {
    mode: scopedKey(source, "PROMPT_TRANSLATE", "MODE"),
    from: scopedKey(source, "PROMPT_TRANSLATE", "FROM"),
    to: scopedKey(source, "PROMPT_TRANSLATE", "TO"),
  };
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveArgosPython(): string {
  return promptTranslationReadiness({
    env: process.env,
    fallbackPython: ARGOS_VENV_PYTHON,
    probes: { pathExists: existsSync },
  }).python;
}

export function checkPromptTranslateSupport(
  deps: { canImport?: (python: string) => boolean } = {},
): { ready: true; python: string } | { ready: false } {
  const readiness = promptTranslationReadiness({
    env: process.env,
    fallbackPython: ARGOS_VENV_PYTHON,
    probes: { pathExists: existsSync, pathExecutable: isExecutable },
  });
  if (readiness.status !== "ready") return { ready: false };
  const canImport = deps.canImport ?? canImportArgosTranslate;
  return canImport(readiness.python) ? { ready: true, python: readiness.python } : { ready: false };
}

export function isPromptTranslateInstallable(): boolean {
  return !checkPromptTranslateSupport().ready;
}

export function canImportArgosTranslate(
  python: string,
  deps: { run?: typeof execFileSync } = {},
): boolean {
  const run = deps.run ?? execFileSync;
  try {
    run(python, ["-c", "import argostranslate"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function smokeTestPromptTranslation(): Promise<void> {
  const sample = await translateWithArgos("你好", { from: "zh", to: "en", timeoutMs: 30_000 });
  if (!sample.trim()) throw new Error("Argos returned empty output");
}

let promptTranslateInstalling = false;

export async function installPromptTranslation(
  deps: {
    checkReady?: () => boolean;
    runInstall?: () => Promise<void>;
    smokeTest?: () => Promise<void>;
  } = {},
): Promise<PromptTranslateInstallResult> {
  const checkReady = deps.checkReady ?? (() => checkPromptTranslateSupport().ready);
  const runInstall =
    deps.runInstall ??
    (async () => {
      await execFileAsync(ARGOS_INSTALL_SCRIPT, [], {
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
    });
  const smokeTest = deps.smokeTest ?? smokeTestPromptTranslation;

  if (checkReady()) {
    try {
      await smokeTest();
      return { status: "already-ready" };
    } catch (err) {
      return { status: "failed", message: normalizeError(err).message };
    }
  }
  if (promptTranslateInstalling) return { status: "in-progress" };
  promptTranslateInstalling = true;
  try {
    await runInstall();
    await smokeTest();
    process.env.ARGOS_TRANSLATE_PYTHON = ARGOS_VENV_PYTHON;
    persistEnvVar("ARGOS_TRANSLATE_PYTHON", ARGOS_VENV_PYTHON);
    return { status: "ok", python: ARGOS_VENV_PYTHON };
  } catch (err) {
    return { status: "failed", message: normalizeError(err).message };
  } finally {
    promptTranslateInstalling = false;
  }
}

function scopedKey(source: PromptTransformSource, prefix: string, suffix: string): string {
  const sourcePrefix = source === "telegram" ? "TELEGRAM" : source === "lark" ? "LARK" : "CONTROL";
  return `${sourcePrefix}_${prefix}_${suffix}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function fromScoped(
  source: PromptTransformSource,
  env: EnvLike,
  prefix: string,
  suffix: string,
): string | undefined {
  const key = scopedKey(source, prefix, suffix);
  return nonEmpty(env[key]);
}

export function resolvePromptTranslateConfig(
  source: PromptTransformSource,
  env: EnvLike = process.env,
): PromptTranslateConfig {
  const rawMode =
    fromScoped(source, env, "PROMPT_TRANSLATE", "MODE") ||
    nonEmpty(env.PROMPT_TRANSLATE_MODE) ||
    fromScoped(source, env, "VOICE_TRANSLATE", "MODE") ||
    nonEmpty(env.VOICE_TRANSLATE_MODE) ||
    "off";
  if (rawMode !== "argos" && rawMode !== "argos_zh_en") {
    return { enabled: false, backend: "off" };
  }

  const pair = resolvePromptTranslateLanguagePair(source, env);
  return {
    enabled: true,
    backend: "argos",
    from: pair.from,
    to: pair.to,
    timeoutMs: positiveInt(
      nonEmpty(env.PROMPT_TRANSLATE_TIMEOUT_MS) || nonEmpty(env.VOICE_TRANSLATE_TIMEOUT_MS),
      DEFAULT_PROMPT_TRANSLATE_TIMEOUT_MS,
    ),
  };
}

function resolvePromptTranslateLanguagePair(
  source: PromptTransformSource,
  env: EnvLike = process.env,
): { from: string; to: string } {
  return {
    from:
      fromScoped(source, env, "PROMPT_TRANSLATE", "FROM") ||
      nonEmpty(env.PROMPT_TRANSLATE_FROM) ||
      fromScoped(source, env, "VOICE_TRANSLATE", "FROM") ||
      nonEmpty(env.VOICE_TRANSLATE_FROM) ||
      "zh",
    to:
      fromScoped(source, env, "PROMPT_TRANSLATE", "TO") ||
      nonEmpty(env.PROMPT_TRANSLATE_TO) ||
      fromScoped(source, env, "VOICE_TRANSLATE", "TO") ||
      nonEmpty(env.VOICE_TRANSLATE_TO) ||
      "en",
  };
}

export async function transformPrompt(
  source: PromptTransformSource,
  text: string,
  deps: { translate?: TranslateText } = {},
): Promise<PromptTransformOutcome> {
  const original = text;
  const config = resolvePromptTranslateConfig(source);
  if (!config.enabled) {
    return { ok: true, original, prompt: original, translated: false };
  }
  const translatable = text.trim();
  if (!translatable) {
    return { ok: true, original, prompt: original, translated: false };
  }

  const translate = deps.translate ?? translateWithArgos;
  try {
    const translated = (
      await translate(translatable, {
        from: config.from,
        to: config.to,
        timeoutMs: config.timeoutMs,
      })
    ).trim();
    if (!translated) return { ok: false, original: translatable, reason: "translate" };
    return { ok: true, original, prompt: translated, translated: true };
  } catch (err) {
    log.error("prompt translation failed", { err });
    return { ok: false, original: translatable, reason: "translate" };
  }
}

export async function prepareUserPrompt(
  source: PromptTransformSource,
  text: string,
  deps: { translate?: TranslateText } = {},
): Promise<PreparedUserPrompt> {
  const transformed = await transformPrompt(source, text, deps);
  if (!transformed.ok) return transformed;
  if (!transformed.translated) {
    return {
      ok: true,
      text: transformed.prompt,
      origin: "user",
      promptSource: source,
      translated: false,
    };
  }
  const config = resolvePromptTranslateConfig(source);
  if (!config.enabled) {
    return {
      ok: true,
      text: transformed.prompt,
      origin: "user",
      promptSource: source,
      translated: false,
    };
  }
  return {
    ok: true,
    text: transformed.prompt,
    origin: "user",
    promptSource: source,
    translated: true,
    sourceText: transformed.original,
    transform: {
      kind: "translation",
      provider: "argos",
      from: config.from,
      to: config.to,
      sourceText: transformed.original,
      deliveredText: transformed.prompt,
    },
  };
}

export function setPromptTranslateConfig(
  source: PromptTransformSource,
  config: { mode: "off" } | { mode: "argos"; from: string; to: string },
): void {
  const keys = promptTranslateEnvKeys(source);
  process.env[keys.mode] = config.mode;
  persistEnvVar(keys.mode, config.mode);
  if (config.mode === "argos") {
    process.env[keys.from] = config.from;
    process.env[keys.to] = config.to;
    persistEnvVar(keys.from, config.from);
    persistEnvVar(keys.to, config.to);
  }
}

export async function applyPromptTranslateCommand(
  source: PromptTransformSource,
  rawArg = "",
  deps: { translate?: TranslateText } = {},
): Promise<PromptTranslateCommandResult> {
  const tokens = rawArg.trim().split(/\s+/).filter(Boolean);
  const verb = (tokens[0] ?? "status").toLowerCase();
  if (verb === "status") return promptTranslateStatus(source);
  if (verb === "off" || verb === "disable" || verb === "disabled") {
    setPromptTranslateConfig(source, { mode: "off" });
    return { ok: true, kind: "disabled", source, mode: "off" };
  }

  const isEnable = verb === "on" || verb === "enable" || verb === "argos";
  const isPairAlias = tokens.length === 2 && !["on", "enable", "argos"].includes(verb);
  if (!isEnable && !isPairAlias) {
    return { ok: false, kind: "usage", usage: "status | off | on [from] [to] | <from> <to>" };
  }

  const current = resolvePromptTranslateConfig(source);
  const pair = current.enabled ? current : resolvePromptTranslateLanguagePair(source);
  const from = tokens[isPairAlias ? 0 : 1] ?? pair.from;
  const to = tokens[isPairAlias ? 1 : 2] ?? pair.to;
  const timeoutMs = current.enabled ? current.timeoutMs : DEFAULT_PROMPT_TRANSLATE_TIMEOUT_MS;
  const translate = deps.translate ?? translateWithArgos;
  try {
    const probe = await translate(healthProbeText(from), { from, to, timeoutMs });
    if (!probe.trim()) throw new Error("provider returned empty output");
  } catch (err) {
    log.error("prompt translation provider health check failed", { err });
    return {
      ok: false,
      kind: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  setPromptTranslateConfig(source, { mode: "argos", from, to });
  return { ok: true, kind: "enabled", source, mode: "argos", from, to, timeoutMs };
}

export function formatPromptTranslateCommandResult(result: PromptTranslateCommandResult): string {
  if (!result.ok) {
    if (result.kind === "usage") return `用法: /prompt_translate ${result.usage}`;
    return `Prompt translation unavailable: ${result.error}`;
  }
  const source = result.source;
  if (result.mode === "off") {
    return result.kind === "disabled"
      ? `Prompt translation disabled for ${source}`
      : `Prompt translation for ${source}: off`;
  }
  const line = `Prompt translation for ${source}: argos ${result.from}->${result.to}`;
  return result.kind === "enabled" ? `Enabled. ${line}` : line;
}

export function promptTranslateStatus(source: PromptTransformSource): PromptTranslateCommandResult {
  const config = resolvePromptTranslateConfig(source);
  if (!config.enabled) return { ok: true, kind: "status", source, mode: "off" };
  return {
    ok: true,
    kind: "status",
    source,
    mode: "argos",
    from: config.from,
    to: config.to,
    timeoutMs: config.timeoutMs,
  };
}

function healthProbeText(from: string): string {
  return from.toLowerCase().startsWith("zh") ? "你好" : "hello";
}

export async function translateWithArgos(
  text: string,
  opts: { from: string; to: string; timeoutMs?: number },
  deps: { canImport?: (python: string) => boolean } = {},
): Promise<string> {
  const python = resolveArgosPython();
  const canImport = deps.canImport ?? canImportArgosTranslate;
  if (!canImport(python)) {
    throw new Error(`argostranslate is not installed for ${python}; run npm run translate:install`);
  }
  const code = [
    "import sys",
    "import argostranslate.translate",
    "text = sys.stdin.read()",
    "translated = argostranslate.translate.translate(text, sys.argv[1], sys.argv[2])",
    "sys.stdout.write(translated)",
  ].join("\n");

  return await execWithInput(
    python,
    ["-c", code, opts.from, opts.to],
    text,
    opts.timeoutMs ?? DEFAULT_PROMPT_TRANSLATE_TIMEOUT_MS,
  );
}

function execWithInput(
  command: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`argos translate timed out after ${timeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`argos translate exited ${code}: ${stderr.trim() || "no stderr"}`));
    });
    child.stdin.end(input);
  });
}
