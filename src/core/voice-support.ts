/**
 * Voice transcription readiness — the single source of truth for whether the
 * optional mlx_whisper feature can run, where its binary lives, and how to
 * persist the resolved path. Keeps all the "is voice usable?" environment logic
 * out of the Telegram adapter so the handler just maps a status to a message.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { normalizeError } from "../shared/utils/error.js";
import { persistEnvVar } from "./env-store.js";
import type { Channel } from "./project-manager.js";

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

/** Outcome of an in-bot voice install. Adapters map each to their own reply. */
export type VoiceInstallResult =
  | { status: "already-ready" }
  | { status: "unsupported" }
  | { status: "in-progress" }
  | { status: "ok"; bin: string }
  | { status: "failed"; message: string };

// Single-flight guard so a double-tap (across either adapter) can't kick off two
// concurrent installs into the same venv.
let voiceInstalling = false;

/**
 * Run the project-managed voice install, then re-check and persist the resolved
 * binary. The single home for the install orchestration so both adapters drive
 * the same flow (no per-adapter drift). Never throws — failures come back as a
 * `failed` result for the caller to render.
 */
export async function installVoice(): Promise<VoiceInstallResult> {
  if (checkVoiceSupport().ready) return { status: "already-ready" };
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
