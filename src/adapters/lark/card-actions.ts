import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { type MessageAction, performStart } from "../../core/dispatch.js";
import { getBinding, isProjectGroup } from "../../core/group-bindings.js";
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
  checkVoiceSupport,
  installVoice,
  isVoiceInstallable,
  isVoicePlatformSupported,
  resolveWhisperLanguage,
  setWhisperLanguage,
  VOICE_LANGS,
} from "../../core/voice-support.js";
import { logger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { verifyValue } from "./card-signing.js";
import { helpCard, langCard, startPickerCard, voiceLangCard } from "./cards.js";
import { type ChatKind, checkAction, type ProjectAction, serviceableChat } from "./chat-policy.js";
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
  /** The serviced chat kind, resolved once by the dispatcher's eligibility gate
   *  (the card callback carries no chat type). Drives the action policy. */
  chatKind: ChatKind;
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

/** Install the optional voice feature in-chat — the Feishu counterpart of
 *  Telegram's `/voice_install`. Shares the core install orchestration so the two
 *  surfaces can't drift. Allowed in any serviced chat (a host setup, not a
 *  project op). */
async function handleVoiceInstall({ channel, evt }: CardCtx): Promise<void> {
  const m = messages("lark");
  if (checkVoiceSupport().ready) {
    await sendText(channel, evt.chatId, m.voiceAlreadyInstalled);
    return;
  }
  if (!isVoicePlatformSupported()) {
    await sendText(channel, evt.chatId, m.voiceUnsupported);
    return;
  }
  await sendText(channel, evt.chatId, m.voiceInstalling); // ack; the install can take minutes
  const result = await installVoice();
  switch (result.status) {
    case "ok":
      logger.info("[lark] voice feature installed and enabled");
      await sendText(channel, evt.chatId, m.voiceInstallOk);
      break;
    case "failed":
      logger.error(`[lark] voice-install failed: ${result.message}`);
      await sendText(channel, evt.chatId, m.voiceInstallFailed(result.message));
      break;
    case "already-ready":
      await sendText(channel, evt.chatId, m.voiceAlreadyInstalled);
      break;
    case "unsupported":
      await sendText(channel, evt.chatId, m.voiceUnsupported);
      break;
    case "in-progress":
      await sendText(channel, evt.chatId, m.voiceInstalling);
      break;
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

/** True for a 1:1 chat. Resolved via the chat API (the card-action callback
 *  carries no chat type). Fail safe: an unresolved chat is treated as not-p2p
 *  so it gets ignored like an unbound group rather than serviced. */
async function isP2pChat(channel: LarkChannel, chatId: string): Promise<boolean> {
  try {
    return (await channel.getChatInfo(chatId)).chatType === "p2p";
  } catch (err) {
    logger.warn(`[lark] getChatInfo failed chat=${chatId}: ${String(err)}`);
    return false;
  }
}

/** Enforce the chat-type policy (chat-policy.ts) for a project/group action.
 *  Returns true when allowed; on refusal it surfaces the policy's message — a
 *  static refusal, or the "pinned, rebind instead" redirect for a group — and
 *  returns false. Single source: both surfaces consult ACTION_POLICY. */
async function gateAction(ctx: CardCtx, action: ProjectAction): Promise<boolean> {
  const verdict = checkAction(action, ctx.chatKind);
  if (verdict.ok) return true;
  if (verdict.deny.kind === "pinned") {
    const label = getBinding(ctx.evt.chatId)?.label ?? "";
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark").groupPinnedNoSwitch(label));
  } else {
    await sendText(ctx.channel, ctx.evt.chatId, messages("lark")[verdict.deny.key]);
  }
  return false;
}

async function handleSwitch(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "switch"))) return;
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

async function handleRemove(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  // Removing a project kills its tmux session — too destructive for a shared
  // group (it could be someone else's project); private chat only per policy.
  if (!(await gateAction(ctx, "remove"))) return;
  const session = await resolveAliveSessionByShortId(deps, value.sid);
  if (!session) return;
  await removeProjectBySession(deps, session);
  removeReplyTargetSession(session);
  await sendText(channel, evt.chatId, messages("lark").removed);
}

async function handleAddRecent(ctx: CardCtx): Promise<void> {
  if (!ctx.value?.sid) return;
  if (!(await gateAction(ctx, "addRecent"))) return;
  await addRecentBySid(ctx.channel, ctx.deps, ctx.evt.chatId, ctx.value.sid);
}

/** Create a bound group — private chat only per policy, mirroring `/newgroup`. */
async function handleMakeGroup(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "createGroup"))) return;
  await makeBoundGroupBySid(channel, deps, evt.chatId, value.sid, evt.operator.openId);
}

/** Bind the current chat to a project — group only per policy, mirroring `/bind`. */
async function handleBindHere(ctx: CardCtx): Promise<void> {
  const { channel, deps, evt, value } = ctx;
  if (!value?.sid) return;
  if (!(await gateAction(ctx, "bind"))) return;
  await bindCurrentGroupBySid(channel, deps, evt.chatId, value.sid);
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
    await sendCard(channel, evt.chatId, helpCard(isProjectGroup(evt.chatId), isVoiceInstallable()));
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
  voiceinstall: handleVoiceInstall,
  // UI-language picker (/lang).
  uilangmenu: async ({ channel, evt }) => {
    await sendManagedCard(channel, evt.chatId, langCard(resolveUiLang("lark")));
  },
  uilang: handleUiLang,
  switch: handleSwitch,
  remove: handleRemove,
  addrecent: handleAddRecent,
  // --- Project-group buttons (no typing needed) ---
  groupmenu: ({ channel, deps, evt }) => sendGroupMenu(channel, deps, evt.chatId),
  makegroup: handleMakeGroup,
  bindhere: handleBindHere,
  rebind: ({ channel, deps, evt }) => sendGroupBindPicker(channel, deps, evt.chatId),
  unbind: ({ channel, deps, evt, chatKind }) => handleUnbind(channel, deps, evt.chatId, chatKind),
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

    // Mirror the text handler (handlers.ts): only 1:1 chats and bound project
    // groups are serviced (serviceableChat). An unbound group — including one
    // whose binding was lost — is ignored, so its (possibly stale) buttons do
    // nothing. Bound is a cheap local check; only hit the chat API otherwise.
    // Resolve the chat kind ONCE here and thread it into the handlers so the
    // per-action policy (chat-policy.ts) is enforced symmetrically with text.
    const isP2p = isProjectGroup(evt.chatId) ? false : await isP2pChat(channel, evt.chatId);
    if (!serviceableChat(isP2p, evt.chatId)) {
      logger.info(`[lark] ignore cardAction in unbound chat=${evt.chatId} cmd=${cmd}`);
      return;
    }
    const chatKind: ChatKind = isP2p ? "p2p" : "group";

    // Multi-command start: show a picker instead of starting the single default.
    // With a single start command, fall through to the queued-action routing.
    if (cmd === "start" && deps.config.startCommands.length > 1) {
      await sendCard(channel, evt.chatId, startPickerCard(deps.config.startCommands));
      return;
    }

    const handler = CARD_HANDLERS[cmd];
    if (handler) {
      await handler({ channel, deps, evt, value, chatKind });
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
