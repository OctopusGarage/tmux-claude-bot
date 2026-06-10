import * as fs from "node:fs";
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { transcribeOgg } from "../../core/transcriber.js";
import { checkVoiceSupport, resolveWhisperLanguage } from "../../core/voice-support.js";
import { logger } from "../../shared/utils/logger.js";
import { enqueueLarkAction } from "./executor.js";
import { sendText } from "./replies.js";

/**
 * Transcribe a Feishu voice/audio message and feed the text into the normal
 * flow — mirrors the Telegram voice handler, reusing the same mlx_whisper core
 * (`checkVoiceSupport` / `resolveWhisperLanguage` / `transcribeOgg`).
 */
export async function handleLarkVoice(
  channel: LarkChannel,
  deps: HandlerDeps,
  msg: NormalizedMessage,
  audio: ResourceDescriptor,
  replySession?: string,
): Promise<void> {
  const support = checkVoiceSupport();
  if (!support.ready) {
    const hint =
      support.reason === "unsupported-platform"
        ? "语音转写仅支持 Apple Silicon"
        : "语音转写未安装（在仓库运行 npm run whisper:install）";
    await sendText(channel, msg.chatId, hint);
    return;
  }

  // Feishu voice arrives as an audio resource; download it via the "file"
  // resource type, write a temp file, and hand it to mlx_whisper.
  const tmpPath = `/tmp/lark_voice_${Date.now()}.opus`;
  let transcribed: string;
  try {
    const buf = await channel.downloadResource(audio.fileKey, "file");
    fs.writeFileSync(tmpPath, buf);
    transcribed = await transcribeOgg(tmpPath, support.bin, resolveWhisperLanguage());
  } catch (err) {
    logger.error(`[lark] voice transcription failed: ${err instanceof Error ? err.message : err}`);
    await sendText(channel, msg.chatId, "转写失败 · 请重试或改发文字");
    return;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
  }

  if (!transcribed.trim()) {
    await sendText(channel, msg.chatId, "转写为空 · 请重试");
    return;
  }

  logger.info(`[lark] voice transcribed chat=${msg.chatId} len=${transcribed.length}`);
  // Echo the transcription (like Telegram), then process it as a normal prompt.
  await sendText(channel, msg.chatId, `🎙️ 你说的是：「${transcribed}」`);
  await enqueueLarkAction(
    channel,
    deps,
    msg.chatId,
    msg.messageId,
    "text",
    transcribed,
    replySession,
  );
}
