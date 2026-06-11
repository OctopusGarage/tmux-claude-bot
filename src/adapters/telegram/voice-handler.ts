import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { promisify } from "node:util";
import type { Bot, Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { chatScope } from "../../core/project-manager.js";
import { transcribeOgg } from "../../core/transcriber.js";
import {
  checkVoiceSupport,
  INSTALL_SCRIPT,
  isVoicePlatformSupported,
  persistWhisperBin,
  resolveWhisperLanguage,
  setWhisperLanguage,
} from "../../core/voice-support.js";
import { normalizeError } from "../../shared/utils/error.js";
import { logger } from "../../shared/utils/logger.js";
import { getFromCache, saveToCache } from "../../shared/utils/media-cache.js";
import { withRetry } from "../../shared/utils/retry.js";
import { buildVoiceLangKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import { runPromptWithProgress } from "./prompt-lifecycle.js";
import { reply } from "./replies.js";
import { resolveSessionForMessage } from "./reply-routing.js";
import type { ReplyTargetMap } from "./reply-target.js";

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 300_000;

export function registerVoiceHandler<TContext extends Context>(
  bot: Bot<TContext>,
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
): void {
  // In-bot trigger to install the optional voice feature (Apple Silicon only).
  // `installing` guards against a double-tap kicking off two installs at once.
  let installing = false;
  bot.command("voice_install", async (ctx: Context) => {
    if (checkVoiceSupport().ready) {
      await reply(ctx, "info", MSG.voiceAlreadyInstalled, { replyTarget });
      return;
    }
    if (!isVoicePlatformSupported()) {
      await reply(ctx, "err", MSG.voiceUnsupported, { replyTarget });
      return;
    }
    if (installing) {
      await reply(ctx, "info", MSG.voiceInstalling, { replyTarget });
      return;
    }
    installing = true;
    await reply(ctx, "info", MSG.voiceInstalling, { replyTarget });
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
      logger.info("[voice-install] voice feature installed and enabled");
      await reply(ctx, "info", MSG.voiceInstallOk, { replyTarget });
    } catch (err) {
      logger.error(`[voice-install] failed: ${err}`);
      await reply(ctx, "err", MSG.voiceInstallFailed(normalizeError(err).message), { replyTarget });
    } finally {
      installing = false;
    }
  });

  // Set/show the forced recognition language. Works any time (even before the
  // feature is installed) so the preference is ready when voice is enabled.
  bot.command("voice_lang", async (ctx: Context) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.trim().toLowerCase();
    if (!arg) {
      // No arg → show a button picker; tapping is handled in handleCallbackQuery.
      const current = resolveWhisperLanguage("telegram");
      await reply(ctx, "info", MSG.voiceLangCurrent(current), {
        replyTarget,
        replyMarkup: buildVoiceLangKeyboard(current),
      });
      return;
    }
    // Accept `auto` or a 2-3 letter whisper code (covers yue = Cantonese).
    if (!/^(auto|[a-z]{2,3})$/.test(arg)) {
      await reply(ctx, "err", MSG.voiceLangInvalid, { replyTarget });
      return;
    }
    setWhisperLanguage("telegram", arg);
    logger.info(`[voice-lang] telegram recognition language set to ${arg}`);
    await reply(ctx, "info", MSG.voiceLangSet(arg), { replyTarget });
  });

  bot.on("message:voice", async (ctx: Context) => {
    const chatId = ctx.chat?.id ?? "unknown";
    logger.info(`[voice-handler] voice message received chat=${chatId}`);

    const msg = ctx.message;
    if (!msg) return;

    const voice = msg.voice;
    if (!voice) return;

    // Friendly gate before downloading: if voice isn't usable, tell the user
    // exactly how to enable it instead of failing later with a generic error.
    const support = checkVoiceSupport();
    if (!support.ready) {
      const hint =
        support.reason === "unsupported-platform" ? MSG.voiceUnsupported : MSG.voiceNotInstalled;
      await reply(ctx, "info", hint, { replyTarget });
      return;
    }

    const file = await ctx.getFile();
    if (!file.file_path) {
      await reply(ctx, "err", messages("telegram").voiceDownloadFailed, { replyTarget });
      return;
    }

    const language = resolveWhisperLanguage("telegram");
    const filePath = file.file_path;
    const cacheKey = `telegram:${voice.file_id}`;
    const cachedPath = getFromCache(cacheKey);
    let audioPath: string;
    let tmpToDelete: string | null = null;

    if (cachedPath) {
      logger.info(`[voice-handler] cache hit file_id=${voice.file_id}`);
      audioPath = cachedPath;
    } else {
      const tmpPath = `/tmp/voice_${randomUUID()}.ogg`;
      // 1) Download — retried, because a proxy/network drop here is transient and a
      // single retry usually rides it out. Reported distinctly from a transcribe error.
      try {
        await withRetry(async () => {
          if (filePath.startsWith("http")) {
            // Local Bot API server: file_path is a direct HTTP URL.
            const res = await fetch(filePath);
            if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
            fs.writeFileSync(tmpPath, Buffer.from(await res.arrayBuffer()));
          } else {
            // Standard Bot API: download via hydrateFiles' file.download().
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (file as any).download(tmpPath);
          }
        });
      } catch (err) {
        logger.error(`[voice-handler] download failed: ${err}`);
        await reply(ctx, "err", messages("telegram").voiceDownloadFailed, { replyTarget });
        return;
      }
      audioPath = saveToCache(cacheKey, tmpPath);
      if (audioPath === tmpPath) {
        tmpToDelete = tmpPath;
      } else {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* best-effort */
        }
      }
    }

    // 2) Transcribe — a distinct error so the user knows it downloaded fine but
    // whisper failed (vs a network problem they'd handle differently).
    let transcribed: string;
    try {
      transcribed = await transcribeOgg(audioPath, support.bin, language);
    } catch (err) {
      logger.error(`[voice-handler] transcription failed: ${err}`);
      await reply(ctx, "err", messages("telegram").voiceTranscribeFailed, { replyTarget });
      return;
    } finally {
      if (tmpToDelete) {
        try {
          fs.unlinkSync(tmpToDelete);
        } catch {
          /* cleanup best-effort */
        }
      }
    }

    // 3) Empty result (too short / silence) → ask the user to speak up, not a generic fail.
    if (!transcribed.trim()) {
      await reply(ctx, "err", messages("telegram").voiceEmpty, { replyTarget });
      return;
    }

    logger.info(`[voice-handler] transcribed len=${transcribed.length}`);

    const fallbackSession = await deps.currentProject.get(chatScope("telegram", String(chatId)));
    const currentSession = resolveSessionForMessage(
      msg.reply_to_message?.message_id,
      replyTarget,
      fallbackSession,
    );
    if (!currentSession) {
      await reply(ctx, "err", MSG.noSession, {
        replyTarget,
      });
      return;
    }

    const isRunning = await deps.claude.checkIfRunning(currentSession);
    if (!isRunning) {
      await reply(ctx, "err", MSG.notRunning, { replyTarget });
      return;
    }

    const msgId = msg.message_id;
    replyTarget.record(msgId, currentSession);

    // Confirm transcription to user
    await reply(ctx, "info", messages("telegram").voiceHeard(transcribed), {
      session: currentSession,
      replyTarget,
    });

    await runPromptWithProgress(ctx, deps, currentSession, transcribed, replyTarget);
  });
}
