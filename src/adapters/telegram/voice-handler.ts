import * as fs from "node:fs";
import type { Bot, Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { transcribeOgg } from "../../core/transcriber.js";
import { logger } from "../../shared/utils/logger.js";
import { MSG } from "./messages.js";
import { runPromptWithProgress } from "./prompt-lifecycle.js";
import { reply } from "./replies.js";
import { resolveSessionForMessage } from "./reply-routing.js";
import type { ReplyTargetMap } from "./reply-target.js";

export function registerVoiceHandler<TContext extends Context>(
  bot: Bot<TContext>,
  deps: HandlerDeps,
  replyTarget: ReplyTargetMap,
): void {
  bot.on("message:voice", async (ctx: Context) => {
    const chatId = ctx.chat?.id ?? "unknown";
    logger.info(`[voice-handler] voice message received chat=${chatId}`);

    const msg = ctx.message;
    if (!msg) return;

    const voice = msg.voice;
    if (!voice) return;

    const file = await ctx.getFile();
    if (!file.file_path) {
      await reply(ctx, "err", "转写失败 · 无法下载文件", { replyTarget });
      return;
    }

    let transcribed: string;
    try {
      const file = await ctx.getFile();

      if (file.file_path?.startsWith("http")) {
        // When using local Bot API server, file_path is HTTP URL directly
        const tmpPath = `/tmp/voice_${Date.now()}.ogg`;
        const res = await fetch(file.file_path);
        if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(tmpPath, Buffer.from(buffer));
        transcribed = await transcribeOgg(tmpPath);
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* cleanup best-effort */
        }
      } else {
        // Standard Telegram Bot API: download via file.download() with hydrateFiles
        const tmpPath = `/tmp/voice_${Date.now()}.ogg`;
        // download() added by hydrateFiles at runtime — cast to avoid TS error
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const downloadedPath = await (file as any).download(tmpPath);
        transcribed = await transcribeOgg(downloadedPath);
        try {
          fs.unlinkSync(downloadedPath);
        } catch {
          /* cleanup best-effort */
        }
      }
    } catch (err) {
      logger.error(`[voice-handler] transcription failed: ${err}`);
      await reply(ctx, "err", "转写失败 · 请重试或改发文字", { replyTarget });
      return;
    }

    logger.info(`[voice-handler] transcribed len=${transcribed.length}`);

    const fallbackSession = await deps.currentProject.get();
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
    await reply(ctx, "info", `🎙️ 你说的是：「${transcribed}」`, {
      session: currentSession,
      replyTarget,
    });

    await runPromptWithProgress(ctx, deps, currentSession, transcribed, replyTarget);
  });
}
