/**
 * Voice transcription readiness — the single source of truth for whether the
 * optional mlx_whisper feature can run, where its binary lives, and how to
 * persist the resolved path. Keeps all the "is voice usable?" environment logic
 * out of the Telegram adapter so the handler just maps a status to a message.
 */
import { accessSync, constants, existsSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { persistEnvVar } from "./env-store.js";
import type { Channel } from "./project-manager.js";

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
