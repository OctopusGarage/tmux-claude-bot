import type { CardActionEvent, LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import type { MessageAction } from "../../core/dispatch.js";
import { projectLabel } from "../../core/project-label.js";
import {
  removeProjectBySession,
  resolveAliveSessionByShortId,
  switchToProject,
} from "../../core/project-ops.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { logger } from "../../shared/utils/logger.js";
import { isOpenIdAllowed } from "./auth.js";
import { helpCard } from "./cards.js";
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
      | { cmd?: string; sid?: string; body?: string; title?: string; view?: boolean }
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

    if (cmd === "switch" && value?.sid) {
      const session = await resolveAliveSessionByShortId(deps, value.sid);
      if (session) {
        await switchToProject(deps, session);
        await sendText(
          channel,
          evt.chatId,
          `已切换：${projectLabel(session, getPathBySession(session) ?? undefined)}`,
        );
      }
      return;
    }
    if (cmd === "remove" && value?.sid) {
      const session = await resolveAliveSessionByShortId(deps, value.sid);
      if (session) {
        await removeProjectBySession(deps, session);
        removeReplyTargetSession(session);
        await sendText(channel, evt.chatId, "已移除");
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
