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

type CardValue =
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

interface CardCtx {
  channel: LarkChannel;
  deps: HandlerDeps;
  evt: CardActionEvent;
  value: CardValue;
}

type CardHandler = (ctx: CardCtx) => Promise<void>;

// --- Handlers that need more than a one-liner -------------------------------

async function handleVoiceLang({ channel, evt, value }: CardCtx): Promise<void> {
  if (!(value?.lang && VOICE_LANGS.some((l) => l.code === value.lang))) return;
  setWhisperLanguage("lark", value.lang);
  logger.info(`[lark] voice recognition language set to ${value.lang} via card`);
  // Move the ✅ on the clicked card itself; fall back to a fresh picker when the
  // card isn't managed (e.g. it predates a restart).
  if (!(await updateManagedCard(channel, evt.messageId, voiceLangCard(value.lang)))) {
    await sendManagedCard(channel, evt.chatId, voiceLangCard(value.lang));
  }
}

async function handleUiLang({ channel, evt, value }: CardCtx): Promise<void> {
  const lang = value?.lang;
  if (!lang || !isUiLang(lang)) return;
  setUiLang("lark", lang);
  logger.info(`[lark] ui language set to ${lang} via card`);
  if (!(await updateManagedCard(channel, evt.messageId, langCard(lang)))) {
    await sendManagedCard(channel, evt.chatId, langCard(lang));
  }
}

async function handleSwitch({ channel, deps, evt, value }: CardCtx): Promise<void> {
  if (!value?.sid) return;
  const session = await resolveAliveSessionByShortId(deps, value.sid);
  if (!session) return;
  await switchToProject(deps, chatScope("lark", evt.chatId), session);
  const path = getPathBySession(session) ?? undefined;
  const warn = botSelfRepoWarning(path, chatScope("lark", evt.chatId));
  await sendText(
    channel,
    evt.chatId,
    `${messages("lark").switchedTo(projectLabel(session, path))}${warn ? `\n\n${warn}` : ""}`,
  );
}

async function handleRemove({ channel, deps, evt, value }: CardCtx): Promise<void> {
  if (!value?.sid) return;
  const session = await resolveAliveSessionByShortId(deps, value.sid);
  if (!session) return;
  await removeProjectBySession(deps, session);
  removeReplyTargetSession(session);
  await sendText(channel, evt.chatId, messages("lark").removed);
}

async function handleStartPick({ channel, deps, evt, value }: CardCtx): Promise<void> {
  if (typeof value?.idx !== "number") return;
  const pick = deps.config.startCommands[value.idx];
  if (!pick) return;
  const session = await resolveSession(channel, deps, evt.chatId);
  if (!session) return;
  await performStart(deps, session, pick.command);
  await sendText(channel, evt.chatId, messages("lark").claudeStartedWith(pick.label));
}

/**
 * Button `cmd` → handler. Each returns after doing its work; commands not here
 * fall through to the immediate/queued action routing (and finally a no-op for
 * unknown cmds). `start` is deliberately absent — it needs the picker-vs-fall-
 * through decision made in the dispatcher below.
 */
const CARD_HANDLERS: Record<string, CardHandler> = {
  help: async ({ channel, evt }) => {
    await sendCard(channel, evt.chatId, helpCard());
  },
  noop: async () => {},
  peek: ({ channel, deps, evt }) => sendPeek(channel, deps, evt.chatId),
  history: ({ channel, deps, evt }) => sendHistory(channel, deps, evt.chatId, 0),
  listalive: ({ channel, deps, evt }) => sendAliveList(channel, deps, evt.chatId),
  recent: ({ channel, deps, evt }) => sendRecentList(channel, deps, evt.chatId),
  current: ({ channel, deps, evt }) => sendCurrentProject(channel, deps, evt.chatId),
  queuestatus: ({ channel, deps, evt }) => sendQueueStatus(channel, deps, evt.chatId),
  // Voice recognition-language picker (mirrors Telegram /voice_lang).
  voicelangmenu: async ({ channel, evt }) => {
    await sendManagedCard(channel, evt.chatId, voiceLangCard(resolveWhisperLanguage("lark")));
  },
  voicelang: handleVoiceLang,
  // UI-language picker (/lang).
  uilangmenu: async ({ channel, evt }) => {
    await sendManagedCard(channel, evt.chatId, langCard(resolveUiLang("lark")));
  },
  uilang: handleUiLang,
  switch: handleSwitch,
  remove: handleRemove,
  addrecent: ({ channel, deps, evt, value }) =>
    value?.sid ? addRecentBySid(channel, deps, evt.chatId, value.sid) : Promise.resolve(),
  // --- Project-group buttons (no typing needed) ---
  groupmenu: ({ channel, deps, evt }) => sendGroupMenu(channel, deps, evt.chatId),
  makegroup: ({ channel, deps, evt, value }) =>
    value?.sid
      ? makeBoundGroupBySid(channel, deps, evt.chatId, value.sid, evt.operator.openId)
      : Promise.resolve(),
  bindhere: ({ channel, deps, evt, value }) =>
    value?.sid ? bindCurrentGroupBySid(channel, deps, evt.chatId, value.sid) : Promise.resolve(),
  rebind: ({ channel, deps, evt }) => sendGroupBindPicker(channel, deps, evt.chatId),
  unbind: ({ channel, deps, evt }) => handleUnbind(channel, deps, evt.chatId, "group"),
  restore: ({ channel, deps, evt }) => handleRestore(channel, deps, evt.chatId),
  startpick: handleStartPick,
};

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

    const value = rawValue as CardValue;
    const cmd = value?.cmd;
    if (!cmd) return;

    logger.info(`[lark] cardAction cmd=${cmd} chat=${evt.chatId}`);

    // Multi-command start: show a picker instead of starting the single default.
    // With a single start command, fall through to the queued-action routing.
    if (cmd === "start" && deps.config.startCommands.length > 1) {
      await sendCard(channel, evt.chatId, startPickerCard(deps.config.startCommands));
      return;
    }

    const handler = CARD_HANDLERS[cmd];
    if (handler) {
      await handler({ channel, deps, evt, value });
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
