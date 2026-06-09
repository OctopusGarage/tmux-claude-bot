/**
 * Voice transcription readiness — the single source of truth for whether the
 * optional mlx_whisper feature can run, where its binary lives, and how to
 * persist the resolved path. Keeps all the "is voice usable?" environment logic
 * out of the Telegram adapter so the handler just maps a status to a message.
 */
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { serializeEnv } from "./onboarding.js";

const ROOT = process.cwd();
const ENV_PATH = nodePath.join(ROOT, ".env");

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
 * Resolve the mlx_whisper binary: an explicit MLX_WHISPER_BIN wins, otherwise
 * fall back to the project-managed venv. The fallback lets voice work even if
 * the operator ran the install but never set .env.
 */
export function resolveWhisperBin(): string {
  return process.env.MLX_WHISPER_BIN || WHISPER_VENV_BIN;
}

export function checkVoiceSupport(): VoiceSupport {
  const bin = resolveWhisperBin();
  if (existsSync(bin) && isExecutable(bin)) return { ready: true, bin };
  if (!isVoicePlatformSupported()) return { ready: false, reason: "unsupported-platform" };
  return { ready: false, reason: "not-installed" };
}

/**
 * Persist MLX_WHISPER_BIN into .env so voice survives a restart (the running
 * process picks it up immediately via process.env; this is for next boot).
 * No-op when there is no .env to write into — process.env is enough for now.
 */
export function persistWhisperBin(bin: string): void {
  if (!existsSync(ENV_PATH)) return;
  const current = readFileSync(ENV_PATH, "utf8");
  // Use the existing file as the template: serializeEnv replaces only the
  // MLX_WHISPER_BIN line (or appends it) and leaves every other line untouched.
  const next = serializeEnv(current, { MLX_WHISPER_BIN: bin });
  const tmp = `${ENV_PATH}.tmp`;
  writeFileSync(tmp, next, "utf8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, ENV_PATH);
}
