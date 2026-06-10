import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { logger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { helpCard } from "./cards.js";
import { parseLarkInput } from "./commands.js";
import { enqueueLarkAction, runImmediateLarkAction } from "./executor.js";
import { sendCard, sendText } from "./replies.js";
import { resolveReplyTarget } from "./reply-target.js";
import {
  addProject,
  sendAliveList,
  sendCurrentProject,
  sendHistory,
  sendPeek,
  sendQueueStatus,
  sendRecentList,
} from "./views.js";
import { handleLarkVoice } from "./voice.js";

/**
 * Build the channel `message` handler. p2p text messages are parsed for
 * slash commands; unknown senders are dropped silently.
 */
export function makeMessageHandler(channel: LarkChannel, deps: HandlerDeps) {
  const allowed = deps.config.lark?.allowedOpenIds ?? new Set<string>();

  return async (msg: NormalizedMessage): Promise<void> => {
    if (!isOpenIdAllowed(msg.senderId, allowed)) {
      logger.info(`[lark] drop message from non-allowlisted open_id=${msg.senderId || "?"}`);
      return;
    }
    if (msg.chatType !== "p2p") {
      logger.info(`[lark] ignore non-p2p chat_type=${msg.chatType}`);
      return;
    }

    // If the user replied to a session-bound bot message, route this message
    // back to THAT session instead of the current project. Mirrors Telegram.
    const replySession = msg.replyToMessageId
      ? resolveReplyTarget(msg.replyToMessageId)
      : undefined;

    if (msg.rawContentType !== "text") {
      // Voice/audio → transcribe and process as text (like Telegram); other
      // media isn't supported yet.
      const audio = msg.resources?.find((r) => r.type === "audio");
      if (audio) {
        await handleLarkVoice(channel, deps, msg, audio, replySession);
        return;
      }
      await sendText(channel, msg.chatId, "暂仅支持文本和语音消息");
      return;
    }

    const text = msg.content ?? "";
    if (!text.trim()) return;

    logger.info(`[lark] received text chat=${msg.chatId} len=${text.length}`);

    const parsed = parseLarkInput(text);

    switch (parsed.kind) {
      case "help":
        await sendCard(channel, msg.chatId, helpCard());
        break;

      case "command":
        if (parsed.immediate) {
          await runImmediateLarkAction(
            channel,
            deps,
            msg.chatId,
            msg.messageId,
            parsed.action,
            replySession,
          );
        } else {
          await enqueueLarkAction(
            channel,
            deps,
            msg.chatId,
            msg.messageId,
            parsed.action,
            text.trim(),
            replySession,
          );
        }
        break;

      case "view":
        switch (parsed.name) {
          case "peek":
            await sendPeek(channel, deps, msg.chatId);
            break;
          case "history": {
            // Mirror Telegram: `/history` = latest (index 0); `/history N` shows
            // the Nth round (1-based), so index = N - 1.
            let index = 0;
            if (parsed.arg !== undefined) {
              const n = parseInt(parsed.arg, 10);
              if (!Number.isNaN(n) && n > 0) index = n - 1;
            }
            await sendHistory(channel, deps, msg.chatId, index);
            break;
          }
          case "listalive":
            await sendAliveList(channel, deps, msg.chatId);
            break;
          case "recent":
            await sendRecentList(channel, deps, msg.chatId);
            break;
          case "queuestatus":
            await sendQueueStatus(channel, deps, msg.chatId);
            break;
          case "current":
            await sendCurrentProject(channel, deps, msg.chatId);
            break;
          case "addproject":
            if (!parsed.arg) {
              await sendText(channel, msg.chatId, "用法：/add_project <路径>");
            } else {
              await addProject(channel, deps, msg.chatId, parsed.arg);
            }
            break;
        }
        break;

      case "unknown":
        await sendText(channel, msg.chatId, `未知命令：/${parsed.name}（发送 /help 查看命令）`);
        break;

      case "text":
        await enqueueLarkAction(
          channel,
          deps,
          msg.chatId,
          msg.messageId,
          "text",
          parsed.text,
          replySession,
        );
        break;
    }
  };
}
