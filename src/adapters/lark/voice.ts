import { randomUUID } from "node:crypto";
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { transcribeWithCache, voiceFailMessage } from "../../core/read/transcriber.js";
import { checkVoiceSupport, resolveWhisperLanguage } from "../../core/read/voice-support.js";
import { createLogger } from "../../shared/utils/logger.js";
import { voiceInstallCard } from "./cards.js";
import { enqueueLarkAction } from "./executor.js";
import { sendCard, sendText } from "./replies.js";
import { downloadMessageResource } from "./resource.js";

const log = createLogger("lark.voice");

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
    if (support.reason === "unsupported-platform") {
      await sendText(channel, msg.chatId, messages("lark").voiceUnsupported);
    } else {
      // Installable: offer a one-tap install button (Feishu has no "/" command).
      await sendCard(channel, msg.chatId, voiceInstallCard());
    }
    return;
  }

  // Feishu voice is a MESSAGE resource: download it via im.v1.messageResource.get
  // (needs the message_id), NOT the channel's downloadResource — that hits
  // im.v1.file.get (standalone files) and 400s on message media (the transcription-failed bug).
  const larkCfg = deps.config.lark;
  if (!larkCfg) {
    await sendText(channel, msg.chatId, messages("lark").voiceDownloadFailed);
    return;
  }
  const outcome = await transcribeWithCache({
    label: "lark",
    cacheKey: `lark:${audio.fileKey}`,
    // Feishu voice is a MESSAGE resource: download via im.v1.messageResource.get
    // (needs the message_id), NOT the channel's downloadResource.
    tmpPath: `/tmp/lark_voice_${randomUUID()}.opus`,
    bin: support.bin,
    language: resolveWhisperLanguage("lark"),
    download: (tmpPath) => downloadMessageResource(larkCfg, msg.messageId, audio.fileKey, tmpPath),
  });
  if (!outcome.ok) {
    await sendText(channel, msg.chatId, voiceFailMessage(outcome.reason, messages("lark")));
    return;
  }
  const transcribed = outcome.text;

  log.info(`voice transcribed chat=${msg.chatId} len=${transcribed.length}`);
  await enqueueLarkAction(
    channel,
    deps,
    msg.chatId,
    msg.messageId,
    "text",
    transcribed,
    replySession,
    msg.chatType === "p2p",
    "voice",
  );
}
