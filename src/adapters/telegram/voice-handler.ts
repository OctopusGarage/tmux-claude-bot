import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { promisify } from "node:util";
import type { Bot, Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { chatScope } from "../../core/project-manager.js";
import { transcribeWithCache } from "../../core/transcriber.js";
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

    const filePath = file.file_path;
    const outcome = await transcribeWithCache({
      label: "voice-handler",
      cacheKey: `telegram:${voice.file_id}`,
      tmpPath: `/tmp/voice_${randomUUID()}.ogg`,
      bin: support.bin,
      language: resolveWhisperLanguage("telegram"),
      download: async (tmpPath) => {
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
      },
    });
    if (!outcome.ok) {
      const m = messages("telegram");
      const hint =
        outcome.reason === "download"
          ? m.voiceDownloadFailed
          : outcome.reason === "transcribe"
            ? m.voiceTranscribeFailed
            : m.voiceEmpty;
      await reply(ctx, "err", hint, { replyTarget });
      return;
    }
    const transcribed = outcome.text;

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
