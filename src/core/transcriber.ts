import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { promisify } from "node:util";
import { logger } from "../shared/utils/logger.js";
import { getFromCache, saveToCache } from "../shared/utils/media-cache.js";
import { withRetry } from "../shared/utils/retry.js";

const execFileAsync = promisify(execFile);

export async function transcribeOgg(
  filePath: string,
  bin?: string,
  language?: string,
): Promise<string> {
  const MLX_WHISPER_BIN = bin ?? process.env.MLX_WHISPER_BIN;
  if (!MLX_WHISPER_BIN) {
    throw new Error("MLX_WHISPER_BIN not configured. Set it in .env");
  }

  const resolved = nodePath.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Input file not found: ${resolved}`);
  }

  const parsed = nodePath.parse(resolved);
  const outputDir = os.tmpdir();

  // Force a language when set (e.g. zh) — whisper's auto-detect frequently
  // mistakes Chinese for Japanese. "auto"/empty leaves detection to whisper.
  // Arg-vector exec (no shell) so a path with spaces/metacharacters can't break
  // or inject — the security property lives here in core, not in callers.
  const langArgs = language && language !== "auto" ? ["--language", language] : [];
  await execFileAsync(MLX_WHISPER_BIN, [
    resolved,
    "--output-format",
    "txt",
    "--output-dir",
    outputDir,
    ...langArgs,
  ]);

  const txtFile = nodePath.join(outputDir, `${parsed.name}.txt`);
  if (!fs.existsSync(txtFile)) {
    throw new Error(`Transcription output not found: ${txtFile}`);
  }
  const content = fs.readFileSync(txtFile, "utf-8").trim();
  fs.unlinkSync(txtFile);
  return content;
}

/** Outcome of {@link transcribeWithCache}: the text, or the stage that failed
 *  so the adapter can pick the right user-facing message. */
export type TranscribeOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "download" | "transcribe" | "empty" };

/**
 * Cache-aware transcription shared by both adapters: look up the audio by
 * `cacheKey`; on a miss, `download(tmpPath)` it (retried — early fetches are
 * flaky on both platforms), cache it, and clean up the temp file; then
 * transcribe. Returns a discriminated outcome instead of sending anything, so
 * each adapter maps the failure stage to its own reply surface.
 *
 * Only the download differs between platforms (Telegram file API vs Feishu
 * message resource) — everything else (cache, temp-file lifecycle, transcribe,
 * empty-result detection) was duplicated and now lives here.
 */
export async function transcribeWithCache(opts: {
  label: string;
  cacheKey: string;
  tmpPath: string;
  bin: string;
  language: string;
  download: (tmpPath: string) => Promise<void>;
}): Promise<TranscribeOutcome> {
  const { label, cacheKey, tmpPath, bin, language, download } = opts;

  let audioPath: string;
  let tmpToDelete: string | null = null;
  const cached = getFromCache(cacheKey);
  if (cached) {
    logger.info(`[${label}] voice cache hit key=${cacheKey}`);
    audioPath = cached;
  } else {
    try {
      await withRetry(() => download(tmpPath));
    } catch (err) {
      logger.error(`[${label}] voice download failed: ${err instanceof Error ? err.message : err}`);
      return { ok: false, reason: "download" };
    }
    audioPath = saveToCache(cacheKey, tmpPath);
    if (audioPath === tmpPath) {
      tmpToDelete = tmpPath; // cache write failed — transcribe from tmp, clean up after
    } else {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
    }
  }

  let transcribed: string;
  try {
    transcribed = await transcribeOgg(audioPath, bin, language);
  } catch (err) {
    logger.error(
      `[${label}] voice transcription failed: ${err instanceof Error ? err.message : err}`,
    );
    return { ok: false, reason: "transcribe" };
  } finally {
    if (tmpToDelete) {
      try {
        fs.unlinkSync(tmpToDelete);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  if (!transcribed.trim()) return { ok: false, reason: "empty" };
  return { ok: true, text: transcribed };
}
