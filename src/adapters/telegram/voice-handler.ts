import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { Bot, Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { chatScope } from "../../core/projects/project-manager.js";
import { runOptionalFeatureInstall } from "../../core/read/optional-feature-install.js";
import { transcribeWithCache, voiceFailMessage } from "../../core/read/transcriber.js";
import {
  checkVoiceSupport,
  installVoice,
  isVoicePlatformSupported,
  resolveWhisperLanguage,
  setWhisperLanguage,
} from "../../core/read/voice-support.js";
import { createLogger } from "../../shared/utils/logger.js";
import { buildVoiceInstallKeyboard, buildVoiceLangKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import { runPromptWithProgress } from "./prompt-lifecycle.js";
import { reply } from "./replies.js";
import { resolveSessionForMessage } from "./reply-routing.js";
import type { ReplyTargetMap } from "./reply-target.js";

const log = createLogger("telegram.voice-handler");

async function runVoiceInstall(ctx: Context, replyTarget: ReplyTargetMap): Promise<void> {
  await runOptionalFeatureInstall({
    copy: {
      installing: MSG.voiceInstalling,
      ok: MSG.voiceInstallOk,
      alreadyReady: MSG.voiceAlreadyInstalled,
      inProgress: MSG.voiceInstalling,
      unsupported: MSG.voiceUnsupported,
      failed: MSG.voiceInstallFailed,
    },
    precheck: () => {
      if (checkVoiceSupport().ready) return { status: "already-ready" };
      if (!isVoicePlatformSupported()) return { status: "unsupported" };
      return null;
    },
    install: () => installVoice(),
    send: async (notice) => {
      await reply(ctx, notice.tone, notice.text, { replyTarget });
    },
    background: true,
    onResult: (result) => {
      if (result.status === "ok") {
        log.info("voice feature installed and enabled");
      } else if (result.status === "failed") {
        log.error("voice install failed", { data: { message: result.message } });
      }
    },
  });
}

export function registerVoiceHandler<TContext extends Context>(
  bot: Bot<TContext>,
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
): void {
  // In-bot trigger to install the optional voice feature (Apple Silicon only).
  // The install orchestration + single-flight guard live in core (installVoice),
  // shared with the Feishu adapter so the two can't drift.
  bot.command("voice_install", async (ctx: Context) => {
    await runVoiceInstall(ctx, replyTarget);
  });

  // Set/show the forced recognition language. Works any time (even before the
  // feature is installed) so the preference is ready when voice is enabled.
  bot.command("voice_lang", async (ctx: Context) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.trim().toLowerCase();
    if (!arg) {
      // No arg → show a button picker; tapping is handled in handleCallbackQuery.
      const current = resolveWhisperLanguage("telegram");
      if (!checkVoiceSupport().ready) {
        await reply(ctx, "info", MSG.voiceNotInstalled, {
          replyTarget,
          replyMarkup: buildVoiceInstallKeyboard(),
        });
        return;
      }
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
    log.info(`telegram recognition language set to ${arg}`);
    await reply(ctx, "info", MSG.voiceLangSet(arg), { replyTarget });
  });

  bot.on("message:voice", async (ctx: Context) => {
    const chatId = ctx.chat?.id ?? "unknown";
    log.info(`voice message received chat=${chatId}`);

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
      await reply(ctx, "err", voiceFailMessage(outcome.reason, messages("telegram")), {
        replyTarget,
      });
      return;
    }
    const transcribed = outcome.text;

    log.info(`transcribed len=${transcribed.length}`);

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

    const isRunning = await deps.agent.checkIfRunning(currentSession);
    if (!isRunning) {
      await reply(ctx, "err", MSG.notRunning, { replyTarget });
      return;
    }

    const msgId = msg.message_id;
    replyTarget.record(msgId, currentSession);

    await runPromptWithProgress(ctx, deps, currentSession, transcribed, replyTarget, "voice");
  });
}
