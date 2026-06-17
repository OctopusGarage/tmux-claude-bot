import type { LarkChannel, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import { PendingQueue } from "../../core/command/pending-queue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { createSubfolder, isAwaitingFolderName } from "../../core/projects/dir-browser.js";
import { reconcileGroupBinding } from "../../core/projects/group-binding-ops.js";
import { isProjectGroup } from "../../core/projects/group-bindings.js";
import { chatScope } from "../../core/projects/project-manager.js";
import { isVoiceInstallable } from "../../core/read/voice-support.js";
import { logger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { browseCard, helpCard } from "./cards.js";
import { isGroupMgmtCommand, isRecoveryCommand, parseLarkInput } from "./commands.js";
import { enqueueLarkAction, runImmediateLarkAction } from "./executor.js";
import {
  handleBind,
  handleNewFreeGroup,
  handleNewGroup,
  handleRestore,
  handleUnbind,
} from "./group-commands.js";
import { sendCard, sendText } from "./replies.js";
import { resolveReplyTarget } from "./reply-target.js";
import {
  addProject,
  handleWsCommand,
  sendAliveList,
  sendBrowse,
  sendCurrentProject,
  sendDoctor,
  sendHistory,
  sendLangPicker,
  sendOrphanList,
  sendPeek,
  sendQueueStatus,
  sendRecentList,
  sendSessionsList,
  sendStatusInstall,
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

  const handle = async (msg: NormalizedMessage): Promise<void> => {
    if (!isOpenIdAllowed(msg.senderId, allowed)) {
      logger.info(`[lark] drop message from non-allowlisted open_id=${msg.senderId || "?"}`);
      return;
    }

    const isP2p = msg.chatType === "p2p";
    if (!isP2p && !isProjectGroup(msg.chatId)) {
      // The group has no binding. Rather than bricking it (a lost binding would
      // otherwise make EVERY message — including the recovery commands — silently
      // dropped, forcing the user to recreate the group), let an allow-listed user
      // run binding-recovery commands (/bind, /rebind, /restore, /newgroup…, /help)
      // in place. Everything else (plain prompts, views) is still ignored: there is
      // no project to talk to until the group is re-bound.
      const recoverable = msg.rawContentType === "text" && isRecoveryCommand(msg.content ?? "");
      if (!recoverable) {
        logger.info(`[lark] ignore unbound chat_type=${msg.chatType} chat=${msg.chatId}`);
        return;
      }
      logger.info(`[lark] unbound chat=${msg.chatId} — allowing recovery command`);
    }

    if (!isP2p) {
      const mgmt = msg.rawContentType === "text" && isGroupMgmtCommand(msg.content ?? "");
      if (!mgmt) {
        const r = await reconcileGroupBinding(deps, "lark", msg.chatId);
        if (r.status === "missing-path") {
          await sendText(channel, msg.chatId, messages("lark").groupMissingPath(r.label));
          return;
        }
        if (r.status === "restored") {
          await sendText(channel, msg.chatId, messages("lark").groupRestored(r.label));
        }
      }
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

    // Directory browser: a pending "new folder" capture takes this text as the
    // folder name (before command parsing, so a name like "help" isn't a command).
    if (isAwaitingFolderName(chatScope("lark", msg.chatId))) {
      const result = createSubfolder(
        chatScope("lark", msg.chatId),
        text,
        deps.config.cdAllowedDirs,
      );
      const m = messages("lark");
      if (result.ok) {
        await sendCard(channel, msg.chatId, browseCard(result.view));
      } else if (result.reason !== "expired") {
        await sendText(
          channel,
          msg.chatId,
          result.reason === "exists"
            ? m.browseNewFolderExists
            : result.reason === "invalid"
              ? m.browseNewFolderInvalid
              : m.browseNewFolderError,
        );
      }
      return;
    }

    const parsed = parseLarkInput(text);

    switch (parsed.kind) {
      case "help":
        await sendCard(
          channel,
          msg.chatId,
          helpCard(isProjectGroup(msg.chatId), isVoiceInstallable()),
        );
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
          case "adopt":
            // Global host op — only in 1:1 chats (a bound group is pinned to one
            // project, so cross-project adoption doesn't belong there).
            if (msg.chatType === "p2p") await sendOrphanList(channel, msg.chatId);
            break;
          case "statusinstall":
            if (msg.chatType === "p2p") await sendStatusInstall(channel, msg.chatId);
            break;
          case "voicelang":
            await sendVoiceLangPicker(channel, msg.chatId);
            break;
          case "uilang":
            await sendLangPicker(channel, msg.chatId);
            break;
          case "addproject":
            if (!parsed.arg) {
              await sendBrowse(channel, deps, msg.chatId);
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
          case "doctor":
            await sendDoctor(channel, msg.chatId);
            break;
          case "newgroup":
            await handleNewGroup(channel, deps, msg.chatId, msg.chatType, msg.senderId, parsed.arg);
            break;
          case "newfreegroup":
            await handleNewFreeGroup(
              channel,
              deps,
              msg.chatId,
              msg.chatType,
              msg.senderId,
              parsed.arg,
            );
            break;
          case "bind":
          case "rebind":
            await handleBind(channel, deps, msg.chatId, msg.chatType, parsed.arg);
            break;
          case "unbind":
            await handleUnbind(channel, deps, msg.chatId, msg.chatType);
            break;
          case "restore":
            await handleRestore(channel, deps, msg.chatId);
            break;
        }
        break;

      case "unknown":
        // No "/" command discovery on Feishu — show the full button menu so an
        // unknown command isn't a dead end.
        await sendText(channel, msg.chatId, messages("lark").unknownCommand(parsed.name));
        await sendCard(
          channel,
          msg.chatId,
          helpCard(isProjectGroup(msg.chatId), isVoiceInstallable()),
        );
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

  // Top-level boundary: no single message may take the handler down or vanish
  // silently. A throw from reconcile (e.g. the tmux server briefly down) or a
  // failed session (re)create is logged and surfaced to the chat, so the user
  // gets feedback and can /restore — instead of an unhandled rejection.
  return async (msg: NormalizedMessage): Promise<void> => {
    try {
      await handle(msg);
    } catch (err) {
      logger.error(
        `[lark] handler error chat=${msg.chatId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      try {
        await sendText(channel, msg.chatId, messages("lark").handlerError);
      } catch {
        // best-effort reply — the original error is already logged
      }
    }
  };
}
