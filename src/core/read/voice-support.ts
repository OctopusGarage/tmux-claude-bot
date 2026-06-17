/**
 * Voice transcription readiness — the single source of truth for whether the
 * optional mlx_whisper feature can run, where its binary lives, and how to
 * persist the resolved path. Keeps all the "is voice usable?" environment logic
 * out of the Telegram adapter so the handler just maps a status to a message.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { normalizeError } from "../../shared/utils/error.js";
import { persistEnvVar } from "../infra/env-store.js";
import type { Channel } from "../projects/project-manager.js";
import { transcribeOgg } from "./transcriber.js";

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 300_000;

const ROOT = process.cwd();

/** Binary produced by `npm run whisper:install` (project-managed venv). */
export const WHISPER_VENV_BIN = nodePath.join(ROOT, ".venv", "bin", "mlx_whisper");
/** The install script the in-bot `/voice_install` command runs. */
export const INSTALL_SCRIPT = nodePath.join(ROOT, "scripts", "install-whisper.sh");

export type VoiceSupport =
  | { ready: true; bin: string }
  | { ready: false; reason: "not-installed" | "unsupported-platform" };

/** mlx-whisper only runs on Apple Silicon (macOS arm64). */
export function isVoicePlatformSupported(): boolean {
  return os.platform() === "darwin" && os.arch() === "arm64";
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the mlx_whisper binary: an explicit MLX_WHISPER_BIN wins, but ONLY
 * when it points at a file that actually exists — otherwise a stale path (dev
 * borrowing prod's .env, or a moved install) would mask a working project venv
 * and make voice look uninstalled. Falling back to the venv lets `/voice_install`
 * (which builds the venv at cwd) work even when .env points elsewhere.
 */
export function resolveWhisperBin(): string {
  const explicit = process.env.MLX_WHISPER_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  return WHISPER_VENV_BIN;
}

/** Default recognition language: Chinese — whisper auto-detect often misreads it as Japanese. */
export const DEFAULT_WHISPER_LANGUAGE = "zh";

/**
 * Selectable recognition languages (mlx_whisper codes + display labels), in
 * display order. "auto" clears the forced language and lets whisper detect.
 * Shared by the Telegram keyboard picker and the Lark card picker.
 */
export const VOICE_LANGS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "yue", label: "粵語" },
  { code: "ja", label: "日本語" },
  { code: "es", label: "Español" },
  { code: "auto", label: "🌐 自动检测" },
];

function whisperLangEnvKey(channel: Channel): string {
  return channel === "telegram" ? "TELEGRAM_WHISPER_LANGUAGE" : "LARK_WHISPER_LANGUAGE";
}

/**
 * Resolve the forced recognition language for mlx_whisper, PER CHANNEL. Each
 * channel keeps its own language (`TELEGRAM_WHISPER_LANGUAGE` /
 * `LARK_WHISPER_LANGUAGE`) so e.g. Feishu can be Cantonese while Telegram is
 * Mandarin; both fall back to the shared `WHISPER_LANGUAGE`, then to zh. "auto"
 * means let whisper detect. Omit `channel` to read just the shared default.
 */
export function resolveWhisperLanguage(channel?: Channel): string {
  if (channel) {
    const perChannel = process.env[whisperLangEnvKey(channel)];
    if (perChannel) return perChannel;
  }
  return process.env.WHISPER_LANGUAGE || DEFAULT_WHISPER_LANGUAGE;
}

/** Set + persist a channel's recognition language (live + survives restart). */
export function setWhisperLanguage(channel: Channel, lang: string): void {
  const key = whisperLangEnvKey(channel);
  process.env[key] = lang;
  persistEnvVar(key, lang);
}

export function checkVoiceSupport(): VoiceSupport {
  const bin = resolveWhisperBin();
  if (existsSync(bin) && isExecutable(bin)) return { ready: true, bin };
  if (!isVoicePlatformSupported()) return { ready: false, reason: "unsupported-platform" };
  return { ready: false, reason: "not-installed" };
}

export function persistWhisperBin(bin: string): void {
  persistEnvVar("MLX_WHISPER_BIN", bin);
}

/** True when voice CAN be installed here: a supported host that isn't set up
 *  yet. Drives whether to surface the in-chat install affordance. */
export function isVoiceInstallable(): boolean {
  return !checkVoiceSupport().ready && isVoicePlatformSupported();
}

/** Outcome of an in-bot voice install. Adapters map each to their own reply. */
export type VoiceInstallResult =
  | { status: "already-ready" }
  | { status: "unsupported" }
  | { status: "in-progress" }
  | { status: "ok"; bin: string }
  | { status: "failed"; message: string };

/**
 * Distinct, non-"auto" recognition languages actually in use across channels
 * (plus the shared default). These are what a readiness check must PROVE the
 * model can handle — the picker offers `yue`, but only large-v3 models support
 * it, so a smaller model silently breaks every Cantonese message.
 */
export function configuredWhisperLanguages(): string[] {
  const langs = [
    resolveWhisperLanguage("telegram"),
    resolveWhisperLanguage("lark"),
    resolveWhisperLanguage(),
  ].filter((l): l is string => Boolean(l) && l !== "auto");
  const distinct = [...new Set(langs)];
  return distinct.length > 0 ? distinct : [DEFAULT_WHISPER_LANGUAGE];
}

/**
 * End-to-end voice smoke test: synthesize a short sample (`say` is always present
 * on the macOS-arm64 host voice requires) and actually transcribe it with EVERY
 * configured language. Makes "voice is ready" honest — it now means the whole
 * pipeline works (ffmpeg decode + model load + each language's tokenizer), not
 * merely that a binary file exists. Throws (with whisper's own reason) on the
 * first language the installed model can't handle. `noFallback` so a model that
 * can't do a language is reported, not silently downgraded to auto-detect.
 */
export async function smokeTestVoice(bin: string): Promise<void> {
  const sample = nodePath.join(os.tmpdir(), `tcb-voice-check-${process.pid}.aiff`);
  await execFileAsync("say", ["-o", sample, "voice check"]);
  try {
    for (const lang of configuredWhisperLanguages()) {
      await transcribeOgg(sample, bin, lang, { noFallback: true });
    }
  } finally {
    try {
      unlinkSync(sample);
    } catch {
      /* best effort */
    }
  }
}

// Single-flight guard so a double-tap (across either adapter) can't kick off two
// concurrent installs into the same venv.
let voiceInstalling = false;

/**
 * Run the project-managed voice install, then re-check, SMOKE-TEST, and persist
 * the resolved binary. The single home for the install orchestration so both
 * adapters drive the same flow (no per-adapter drift). Never throws — failures
 * come back as a `failed` result for the caller to render.
 *
 * The smoke test runs on BOTH paths — already-installed and freshly-installed —
 * because "the binary exists" is not the same as "transcription works": a model
 * that can't handle the configured language (the yue+tiny crash) passed the old
 * existence-only check and falsely reported ready. `smokeTest` is injectable for
 * tests.
 */
export async function installVoice(
  deps: { smokeTest?: (bin: string) => Promise<void> } = {},
): Promise<VoiceInstallResult> {
  const smokeTest = deps.smokeTest ?? smokeTestVoice;

  const existing = checkVoiceSupport();
  if (existing.ready) {
    // Binary present — but verify it actually transcribes before claiming ready.
    try {
      await smokeTest(existing.bin);
      return { status: "already-ready" };
    } catch (err) {
      return { status: "failed", message: normalizeError(err).message };
    }
  }
  if (!isVoicePlatformSupported()) return { status: "unsupported" };
  if (voiceInstalling) return { status: "in-progress" };
  voiceInstalling = true;
  try {
    // Fixed bundled script, no user-controlled args — not arbitrary exec.
    await execFileAsync(INSTALL_SCRIPT, [], {
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const status = checkVoiceSupport();
    if (!status.ready) throw new Error("binary still missing after install");
    // Prove transcription actually works (model + each configured language)
    // before declaring ready — the gap that let the yue crash ship as "ready".
    await smokeTest(status.bin);
    // Live process reads process.env at transcribe time; persist for restarts.
    process.env.MLX_WHISPER_BIN = status.bin;
    persistWhisperBin(status.bin);
    return { status: "ok", bin: status.bin };
  } catch (err) {
    return { status: "failed", message: normalizeError(err).message };
  } finally {
    voiceInstalling = false;
  }
}
