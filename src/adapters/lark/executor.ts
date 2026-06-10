import { randomUUID } from "node:crypto";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { HandlerDeps } from "../../core/deps.js";
import { executeMessage, type MessageAction } from "../../core/dispatch.js";
import { projectLabel } from "../../core/project-label.js";
import type { QueuedMessage } from "../../core/queue.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { logger } from "../../shared/utils/logger.js";
import { resultCard } from "./cards.js";
import { markDone, markWorking } from "./reactions.js";
import { sendCard, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

const NO_SESSION_MSG = "无当前项目，请先在 Telegram 选择/新建项目";

/** "📂 <friendly project>" tag stamped on every reply so the user can see which
 * tmux session received it — mirrors the Telegram adapter's project line. */
function projectTag(session: string): string {
  return `📂 ${projectLabel(session, getPathBySession(session) ?? undefined)}`;
}

async function resolveSession(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  sessionOverride?: string,
): Promise<string | null> {
  const session = sessionOverride ?? (await deps.currentProject.get());
  if (!session) {
    await sendText(channel, chatId, NO_SESSION_MSG);
    return null;
  }
  return session;
}

/**
 * Enqueue any action (text, start, restart, exit) with acks.
 * Resolves the current session, enqueues the message, and sends
 * 已接收 / 已排队 / queue-full replies.
 */
export async function enqueueLarkAction(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  messageId: string,
  action: MessageAction,
  text: string,
  sessionOverride?: string,
): Promise<void> {
  const session = await resolveSession(channel, deps, chatId, sessionOverride);
  if (!session) return;

  const queueSizeBefore = deps.queue.size(session);

  const queued = deps.queue.enqueue({
    id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
    text,
    chatId,
    channel: "lark",
    sessionName: session,
    action,
    resolve: (output) => {
      logger.info(`[lark] resolve session=${session} output_len=${output.length}`);
      void markDone(channel, messageId);
      void (async () => {
        // Only natural-language Claude results carry the control buttons; every
        // other action (start/restart/exit) replies as plain text. Mirrors
        // Telegram, where the control keyboard rides only on the NL result.
        if (action === "text") {
          const mid = await sendCard(channel, chatId, resultCard(output, projectTag(session)));
          if (mid) {
            recordReplyTarget(mid, session);
          }
        } else {
          await sendText(channel, chatId, `${output}\n\n${projectTag(session)}`);
        }
      })();
    },
    reject: (err) => {
      logger.error(`[lark] reject session=${session} err=${err.message}`);
      void sendText(channel, chatId, `错误：${err.message}\n${projectTag(session)}`);
    },
  });

  const tag = projectTag(session);
  if (!queued) {
    logger.warn(`[lark] queue full session=${session} max=${deps.queue.getMaxSize()}`);
    await sendText(
      channel,
      chatId,
      `队列已满（上限 ${deps.queue.getMaxSize()}），请稍后再试\n${tag}`,
    );
    return;
  }

  logger.info(
    `[lark] enqueued action=${action} session=${session} queueSizeBefore=${queueSizeBefore}`,
  );
  void markWorking(channel, messageId);
  if (queueSizeBefore === 0) {
    await sendText(channel, chatId, `已接收\n${tag}`);
  } else {
    await sendText(channel, chatId, `已排队 · 第 ${queueSizeBefore} 位\n${tag}`);
  }
}

/**
 * Run an immediate action directly (bypass queue), reply the result.
 */
export async function runImmediateLarkAction(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  messageId: string,
  action: MessageAction,
  sessionOverride?: string,
): Promise<void> {
  const session = await resolveSession(channel, deps, chatId, sessionOverride);
  if (!session) return;

  const msg: QueuedMessage = {
    id: "",
    text: "",
    chatId,
    channel: "lark",
    sessionName: session,
    action,
    resolve: () => {},
    reject: () => {},
  };

  void markWorking(channel, messageId);
  try {
    const result = await executeMessage(msg, deps);
    void markDone(channel, messageId);
    // Immediate actions are commands (esc/clear/status/…), never `text`, so they
    // reply as plain text — no control card. Mirrors Telegram.
    await sendText(channel, chatId, `${result}\n\n${projectTag(session)}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      `[lark] immediate action failed action=${action} session=${session} err=${errMsg}`,
    );
    await sendText(channel, chatId, `错误：${errMsg}\n${projectTag(session)}`);
  }
}
