import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { type MessageAction, performStart } from "../../core/dispatch.js";
import { isUiLang, messages, resolveUiLang, setUiLang } from "../../core/i18n/index.js";
import { projectLabel } from "../../core/project-label.js";
import { chatScope } from "../../core/project-manager.js";
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
import { verifyValue } from "./card-signing.js";
import { helpCard, langCard, startPickerCard, voiceLangCard } from "./cards.js";
import { IMMEDIATE, QUEUED } from "./commands.js";
import { enqueueLarkAction, resolveSession, runImmediateLarkAction } from "./executor.js";
import {
  bindCurrentGroupBySid,
  handleRestore,
  handleUnbind,
  makeBoundGroupBySid,
} from "./group-commands.js";
import { sendManagedCard, updateManagedCard } from "./managed-card.js";
import { sendCard, sendText } from "./replies.js";
import { removeReplyTargetSession } from "./reply-target.js";
import {
  addRecentBySid,
  sendAliveList,
  sendCurrentProject,
  sendGroupBindPicker,
  sendGroupMenu,
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

    const rawValue = evt.action?.value;
    if (!verifyValue(rawValue)) {
      logger.warn(`[lark] drop cardAction: invalid signature chat=${evt.chatId}`);
      return;
    }

    const value = rawValue as
      | {
          cmd?: string;
          sid?: string;
          body?: string;
          title?: string;
          view?: boolean;
          lang?: string;
          idx?: number;
        }
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
      await sendManagedCard(channel, evt.chatId, voiceLangCard(resolveWhisperLanguage("lark")));
      return;
    }
    if (cmd === "voicelang" && value?.lang && VOICE_LANGS.some((l) => l.code === value.lang)) {
      setWhisperLanguage("lark", value.lang);
      logger.info(`[lark] voice recognition language set to ${value.lang} via card`);
      // Move the ✅ on the clicked card itself; fall back to a fresh picker
      // when the card isn't managed (e.g. it predates a restart).
      if (!(await updateManagedCard(channel, evt.messageId, voiceLangCard(value.lang)))) {
        await sendManagedCard(channel, evt.chatId, voiceLangCard(value.lang));
      }
      return;
    }
    // UI-language picker (/lang).
    if (cmd === "uilangmenu") {
      await sendManagedCard(channel, evt.chatId, langCard(resolveUiLang("lark")));
      return;
    }
    if (cmd === "uilang" && value?.lang) {
      const lang = value.lang;
      if (isUiLang(lang)) {
        setUiLang("lark", lang);
        logger.info(`[lark] ui language set to ${lang} via card`);
        if (!(await updateManagedCard(channel, evt.messageId, langCard(lang)))) {
          await sendManagedCard(channel, evt.chatId, langCard(lang));
        }
      }
      return;
    }

    if (cmd === "switch" && value?.sid) {
      const session = await resolveAliveSessionByShortId(deps, value.sid);
      if (session) {
        await switchToProject(deps, chatScope("lark", evt.chatId), session);
        const path = getPathBySession(session) ?? undefined;
        const warn = botSelfRepoWarning(path, chatScope("lark", evt.chatId));
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

    // --- Project-group buttons (no typing needed) ---
    if (cmd === "groupmenu") {
      await sendGroupMenu(channel, deps, evt.chatId);
      return;
    }
    if (cmd === "makegroup" && value?.sid) {
      await makeBoundGroupBySid(channel, deps, evt.chatId, value.sid, evt.operator.openId);
      return;
    }
    if (cmd === "bindhere" && value?.sid) {
      await bindCurrentGroupBySid(channel, deps, evt.chatId, value.sid);
      return;
    }
    if (cmd === "rebind") {
      await sendGroupBindPicker(channel, deps, evt.chatId);
      return;
    }
    if (cmd === "unbind") {
      await handleUnbind(channel, deps, evt.chatId, "group");
      return;
    }
    if (cmd === "restore") {
      await handleRestore(channel, deps, evt.chatId);
      return;
    }

    // Multi-command start: show a picker instead of starting the single default.
    if (cmd === "start" && deps.config.startCommands.length > 1) {
      await sendCard(channel, evt.chatId, startPickerCard(deps.config.startCommands));
      return;
    }
    if (cmd === "startpick" && typeof value?.idx === "number") {
      const pick = deps.config.startCommands[value.idx];
      if (!pick) return;
      const session = await resolveSession(channel, deps, evt.chatId);
      if (!session) return;
      await performStart(deps, session, pick.command);
      await sendText(channel, evt.chatId, messages("lark").claudeStartedWith(pick.label));
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
