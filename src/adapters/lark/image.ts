import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { LarkChannel, NormalizedMessage, ResourceDescriptor } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { appStateDir } from "../../shared/state-dir.js";
import { normalizeError } from "../../shared/utils/error.js";
import { createLogger } from "../../shared/utils/logger.js";
import { enqueueLarkAction } from "./executor.js";
import { sendText } from "./replies.js";
import { downloadMessageResource } from "./resource.js";

const log = createLogger("lark.image");

function safePathSegment(value: string): string {
  const encoded = encodeURIComponent(value).replaceAll("%", "_");
  return encoded === "." || encoded === ".." || encoded.length === 0 ? "image" : encoded;
}

export function findLarkImageResource(
  resources: readonly ResourceDescriptor[],
): ResourceDescriptor | undefined {
  return resources.find((resource) => resource.type === "image");
}

export async function handleLarkImage(
  channel: LarkChannel,
  deps: HandlerDeps,
  msg: NormalizedMessage,
  image = findLarkImageResource(msg.resources),
  replySession?: string,
): Promise<void> {
  const m = messages("lark");
  const larkCfg = deps.config.lark;
  if (!larkCfg || !image) {
    await sendText(channel, msg.chatId, m.imageDownloadFailed);
    return;
  }

  const dir = nodePath.join(appStateDir(), "attachments", "lark", safePathSegment(msg.messageId));
  const destPath = nodePath.join(dir, `${safePathSegment(image.fileKey)}.image`);

  try {
    await fs.mkdir(dir, { recursive: true });
    await downloadMessageResource(larkCfg, msg.messageId, image.fileKey, destPath, "image");
  } catch (err) {
    const normalized = normalizeError(err);
    log.warn(`image download failed msg=${msg.messageId}: ${normalized.message}`, {
      err: normalized,
    });
    await sendText(channel, msg.chatId, m.imageDownloadFailed);
    return;
  }

  const captionOrDefault = msg.content.trim() || m.imageAnalyzePrompt;
  const prompt = `${captionOrDefault}\n\nImage path: ${destPath}`;
  await enqueueLarkAction(
    channel,
    deps,
    msg.chatId,
    msg.messageId,
    "text",
    prompt,
    replySession,
    msg.chatType === "p2p",
    "image",
  );
}
