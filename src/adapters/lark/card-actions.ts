import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import type { MessageAction } from "../../core/dispatch.js";
import { isUiLang, messages, resolveUiLang, setUiLang } from "../../core/i18n/index.js";
import { projectLabel } from "../../core/project-label.js";
import {
  botSelfRepoWarning,
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "../../core/project-ops.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import {
  resolveWhisperLanguage,
  setWhisperLanguage,
  VOICE_LANGS,
} from "../../core/voice-support.js";
import { logger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { helpCard, langCard, voiceLangCard } from "./cards.js";
import { IMMEDIATE, QUEUED } from "./commands.js";
import { enqueueLarkAction, runImmediateLarkAction } from "./executor.js";
import { sendCard, sendText } from "./replies.js";
import { removeReplyTargetSession } from "./reply-target.js";
import {
  addRecentBySid,
  sendAliveList,
  sendCurrentProject,
  sendHistory,
  sendPeek,
  sendQueueStatus,
  sendRecentList,
} from "./views.js";

/**
 * Build the channel `cardAction` handler. Button clicks carry a
 * `{ cmd }` value that maps onto the same immediate/queued routing as
 * text commands. Unknown senders are dropped silently.
 */
export function makeCardActionHandler(channel: LarkChannel, deps: HandlerDeps) {
  const allowed = deps.config.lark?.allowedOpenIds ?? new Set<string>();

  return async (evt: CardActionEvent): Promise<void> => {
    if (!isOpenIdAllowed(evt.operator.openId, allowed)) {
      logger.info(`[lark] drop cardAction from open_id=${evt.operator.openId || "?"}`);
      return;
    }

    const value = evt.action?.value as
      | { cmd?: string; sid?: string; body?: string; title?: string; view?: boolean; lang?: string }
      | undefined;
    const cmd = value?.cmd;
    if (!cmd) return;

    logger.info(`[lark] cardAction cmd=${cmd} chat=${evt.chatId}`);

    if (cmd === "help") {
      await sendCard(channel, evt.chatId, helpCard());
      return;
    }

    if (cmd === "noop") return;

    if (cmd === "peek") {
      await sendPeek(channel, deps, evt.chatId);
      return;
    }
    if (cmd === "history") {
      await sendHistory(channel, deps, evt.chatId, 0);
      return;
    }
    if (cmd === "listalive") {
      await sendAliveList(channel, deps, evt.chatId);
      return;
    }
    if (cmd === "recent") {
      await sendRecentList(channel, deps, evt.chatId);
      return;
    }
    if (cmd === "current") {
      await sendCurrentProject(channel, deps, evt.chatId);
      return;
    }
    if (cmd === "queuestatus") {
      await sendQueueStatus(channel, deps, evt.chatId);
      return;
    }
    // Voice recognition-language picker (mirrors Telegram /voice_lang).
    if (cmd === "voicelangmenu") {
      await sendCard(channel, evt.chatId, voiceLangCard(resolveWhisperLanguage("lark")));
      return;
    }
    if (cmd === "voicelang" && value?.lang && VOICE_LANGS.some((l) => l.code === value.lang)) {
      setWhisperLanguage("lark", value.lang);
      logger.info(`[lark] voice recognition language set to ${value.lang} via card`);
      // Re-send the picker so the ✅ moves to the new selection (updateCard is
      // unreliable for 2.0 cards).
      await sendCard(channel, evt.chatId, voiceLangCard(value.lang));
      return;
    }
    // UI-language picker (/lang).
    if (cmd === "uilangmenu") {
      await sendCard(channel, evt.chatId, langCard(resolveUiLang("lark")));
      return;
    }
    if (cmd === "uilang" && value?.lang) {
      const lang = value.lang;
      if (isUiLang(lang)) {
        setUiLang("lark", lang);
        logger.info(`[lark] ui language set to ${lang} via card`);
        await sendCard(channel, evt.chatId, langCard(lang));
      }
      return;
    }

    if (cmd === "switch" && value?.sid) {
      const session = await resolveAliveSessionByShortId(deps, value.sid);
      if (session) {
        await switchToProject(deps, "lark", session);
        const path = getPathBySession(session) ?? undefined;
        const warn = botSelfRepoWarning(path, "lark");
        await sendText(
          channel,
          evt.chatId,
          `${messages("lark").switchedTo(projectLabel(session, path))}${warn ? `\n\n${warn}` : ""}`,
        );
      }
      return;
    }
    if (cmd === "remove" && value?.sid) {
      const session = await resolveAliveSessionByShortId(deps, value.sid);
      if (session) {
        await removeProjectBySession(deps, session);
        removeReplyTargetSession(session);
        await sendText(channel, evt.chatId, messages("lark").removed);
      }
      return;
    }
    if (cmd === "addrecent" && value?.sid) {
      await addRecentBySid(channel, deps, evt.chatId, value.sid);
      return;
    }

    if (IMMEDIATE.has(cmd as MessageAction)) {
      await runImmediateLarkAction(channel, deps, evt.chatId, evt.messageId, cmd as MessageAction);
      return;
    }

    if (QUEUED.has(cmd as MessageAction)) {
      await enqueueLarkAction(channel, deps, evt.chatId, evt.messageId, cmd as MessageAction, cmd);
      return;
    }

    logger.info(`[lark] unknown cardAction cmd=${cmd}`);
  };
}
