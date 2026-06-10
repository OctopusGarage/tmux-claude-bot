import * as fs from "node:fs";
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { transcribeOgg } from "../../core/transcriber.js";
import { checkVoiceSupport, resolveWhisperLanguage } from "../../core/voice-support.js";
import { logger } from "../../shared/utils/logger.js";
import { enqueueLarkAction } from "./executor.js";
import { sendText } from "./replies.js";
import { downloadMessageResource } from "./resource.js";

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
    const m = messages("lark");
    const hint =
      support.reason === "unsupported-platform" ? m.voiceUnsupported : m.voiceNotInstalled;
    await sendText(channel, msg.chatId, hint);
    return;
  }

  // Feishu voice is a MESSAGE resource: download it via im.v1.messageResource.get
  // (needs the message_id), NOT the channel's downloadResource — that hits
  // im.v1.file.get (standalone files) and 400s on message media (the 转写失败 bug).
  const larkCfg = deps.config.lark;
  const tmpPath = `/tmp/lark_voice_${Date.now()}.opus`;
  let transcribed: string;
  try {
    if (!larkCfg) throw new Error("lark not configured");
    await downloadMessageResource(larkCfg, msg.messageId, audio.fileKey, tmpPath);
    transcribed = await transcribeOgg(tmpPath, support.bin, resolveWhisperLanguage("lark"));
  } catch (err) {
    logger.error(`[lark] voice transcription failed: ${err instanceof Error ? err.message : err}`);
    await sendText(channel, msg.chatId, messages("lark").voiceTranscribeFailed);
    return;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
  }

  if (!transcribed.trim()) {
    await sendText(channel, msg.chatId, messages("lark").voiceEmpty);
    return;
  }

  logger.info(`[lark] voice transcribed chat=${msg.chatId} len=${transcribed.length}`);
  // Echo the transcription (like Telegram), then process it as a normal prompt.
  await sendText(channel, msg.chatId, messages("lark").voiceHeard(transcribed));
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
