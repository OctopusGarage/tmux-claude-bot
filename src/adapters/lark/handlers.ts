import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { PendingQueue } from "../../core/pending-queue.js";
import { logger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { helpCard } from "./cards.js";
import { parseLarkInput } from "./commands.js";
import { enqueueLarkAction, runImmediateLarkAction } from "./executor.js";
import { sendCard, sendText } from "./replies.js";
import { resolveReplyTarget } from "./reply-target.js";
import {
  addProject,
  handleWsCommand,
  sendAliveList,
  sendCurrentProject,
  sendHistory,
  sendLangPicker,
  sendPeek,
  sendQueueStatus,
  sendRecentList,
  sendSessionsList,
  sendVoiceLangPicker,
} from "./views.js";
import { handleLarkVoice } from "./voice.js";

/** Quiet window for merging rapid-fire plain-text messages into one prompt. */
const TEXT_DEBOUNCE_MS = 600;

interface PendingText {
  chatId: string;
  messageId: string;
  text: string;
  replySession: string | undefined;
}

/**
 * Build the channel `message` handler. p2p text messages are parsed for
 * slash commands; unknown senders are dropped silently.
 */
export function makeMessageHandler(channel: LarkChannel, deps: HandlerDeps) {
  const allowed = deps.config.lark?.allowedOpenIds ?? new Set<string>();

  // Plain-text messages debounce briefly so a thought split across several
  // quick sends lands in Claude as ONE prompt. Scope includes the reply
  // target — replies routed to different sessions must never merge.
  // Commands and voice bypass this (parsed before reaching the queue).
  //
  // While a flushed batch is running, the scope is blocked: texts sent during
  // the run accumulate and land as ONE follow-up prompt when it settles,
  // instead of one Claude turn per message.
  const pendingTexts = new PendingQueue<PendingText>(TEXT_DEBOUNCE_MS, async (scope, batch) => {
    const first = batch[0];
    const text = batch.map((b) => b.text).join("\n");
    pendingTexts.block(scope);
    try {
      await enqueueLarkAction(
        channel,
        deps,
        first.chatId,
        first.messageId,
        "text",
        text,
        first.replySession,
        () => pendingTexts.unblock(scope),
      );
    } catch (err) {
      pendingTexts.unblock(scope); // never leave the scope jammed
      throw err;
    }
  });

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
      await sendText(channel, msg.chatId, messages("lark").onlyTextVoice);
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
          case "voicelang":
            await sendVoiceLangPicker(channel, msg.chatId);
            break;
          case "uilang":
            await sendLangPicker(channel, msg.chatId);
            break;
          case "addproject":
            if (!parsed.arg) {
              await sendText(channel, msg.chatId, messages("lark").addProjectUsage);
            } else {
              await addProject(channel, deps, msg.chatId, parsed.arg);
            }
            break;
          case "ws":
            await handleWsCommand(channel, deps, msg.chatId, parsed.arg);
            break;
          case "sessions":
            await sendSessionsList(channel, deps, msg.chatId, parsed.arg);
            break;
        }
        break;

      case "unknown":
        // No "/" command discovery on Feishu — show the full button menu so an
        // unknown command isn't a dead end.
        await sendText(channel, msg.chatId, messages("lark").unknownCommand(parsed.name));
        await sendCard(channel, msg.chatId, helpCard());
        break;

      case "text":
        pendingTexts.push(`${msg.chatId}:${replySession ?? ""}`, {
          chatId: msg.chatId,
          messageId: msg.messageId,
          text: parsed.text,
          replySession,
        });
        break;
    }
  };
}
