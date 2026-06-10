import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { formatSingleConversation, getRecentConversations } from "../../core/history.js";
import { messages } from "../../core/i18n/index.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { truncate } from "../../shared/utils/string.js";
import { buildControlKeyboard, buildProjectKeyboard } from "./keyboards.js";
import { projectLabel } from "./project-label.js";
import { aliveProjectButtons } from "./project-ops.js";
import { reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";

/**
 * Read-side renderers: fetch state (tmux pane, conversation history, queue) and
 * render it into a Telegram reply. No mutation — these only display. Kept apart
 * from command/callback wiring so the "what the user sees" lives in one place.
 */

/** The alive-projects list (tappable switch/delete keyboard, no body text). */
export async function sendAliveList(ctx: Context, deps: HandlerDeps): Promise<void> {
  try {
    const buttons = await aliveProjectButtons(deps, "telegram");
    if (buttons.length === 0) {
      await reply(ctx, "list", messages("telegram").aliveListEmpty);
      return;
    }
    await reply(ctx, "list", messages("telegram").aliveListTitle(buttons.length), {
      replyMarkup: buildProjectKeyboard(buttons),
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`);
  }
}

/** Capture and send the current tmux pane for a session. */
export async function sendPeek(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const keyboard = buildControlKeyboard(sessionShortId(session));
  try {
    const snapshot = await deps.bridge.capturePane(session);
    const processed = deps.output.process(snapshot);
    if (processed) {
      await reply(ctx, "view", "", {
        session,
        body: processed,
        code: true,
        replyMarkup: keyboard,
        replyTarget,
      });
    } else {
      await reply(ctx, "view", messages("telegram").emptyPane, {
        session,
        replyMarkup: keyboard,
        replyTarget,
      });
    }
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { session, replyTarget });
  }
}

/** Send the Nth-most-recent conversation round for a session (0 = latest). */
export async function sendHistory(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  index: number,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  try {
    const projectPath = getPathBySession(session);
    if (!projectPath) {
      await reply(ctx, "warn", messages("telegram").noPathMapping, {
        session,
        replyTarget,
      });
      return;
    }
    const configRoot = await deps.configResolver.resolveConfigRoot(session);
    const rounds = await getRecentConversations(projectPath, configRoot);
    if (rounds.length === 0) {
      await reply(ctx, "info", messages("telegram").noHistory, { session, replyTarget });
      return;
    }
    if (index >= rounds.length) {
      await reply(ctx, "warn", messages("telegram").onlyNRounds(rounds.length), {
        session,
        replyTarget,
      });
      return;
    }
    const round = rounds[index];
    if (round === undefined) return;
    const body = formatSingleConversation(round, index, rounds.length, "telegram");
    await reply(ctx, "view", messages("telegram").historyTitleShort, {
      session,
      body,
      markdown: true,
      replyMarkup: buildControlKeyboard(sessionShortId(session)),
      replyTarget,
    });
  } catch (err) {
    await reply(ctx, "err", `${normalizeError(err).message}`, { session, replyTarget });
  }
}

/** Build and send the message-queue status across global and session queues. */
export async function sendQueueStatus(ctx: Context, deps: HandlerDeps): Promise<void> {
  const lines: string[] = [];

  const globalQueue = deps.queue.getGlobalQueue();
  const globalProcessing = deps.queue.isGlobalProcessing();
  const globalCurrent = deps.queue.getCurrentGlobalMessage();
  lines.push(messages("telegram").queueGlobalHeader);
  lines.push(messages("telegram").queueCounts(globalQueue.length, globalProcessing));
  if (globalCurrent) {
    lines.push(`  ▶ ${truncate(globalCurrent.text, 40)}`);
  }
  if (globalQueue.length > 0) {
    globalQueue.forEach((msg, i) => {
      lines.push(`  ${i + 1}. ${truncate(msg.text, 40)}`);
    });
  }

  const sessionNames = deps.queue.getSessionNames();
  if (sessionNames.length === 0) {
    lines.push(`\n${messages("telegram").queueSessionHeader}`);
    lines.push(messages("telegram").queueNoSessions);
  } else {
    for (const sessionName of sessionNames.sort()) {
      const queueItems = deps.queue.getSessionQueue(sessionName);
      const isProcessing = deps.queue.isSessionProcessing(sessionName);
      const currentMsg = deps.queue.getCurrentSessionMessage(sessionName);
      const lastAt = deps.queue.getLastProcessedAt(sessionName);
      const name = projectLabel(sessionName, getPathBySession(sessionName) ?? undefined);
      lines.push(`\n━━ 📂 ${name} ━━`);
      lines.push(messages("telegram").queueCounts(queueItems.length, isProcessing));
      if (currentMsg) {
        lines.push(`  ▶ ${truncate(currentMsg.text, 40)}`);
      }
      if (queueItems.length > 0) {
        queueItems.forEach((msg, i) => {
          lines.push(`  ${i + 1}. ${truncate(msg.text, 40)}`);
        });
      }
      if (lastAt) {
        const secondsAgo = Math.floor((Date.now() - lastAt) / 1000);
        lines.push(`  ${messages("telegram").queueLastDone(secondsAgo)}`);
      }
    }
  }

  await reply(ctx, "queue", messages("telegram").queueTitle, { body: lines.join("\n") });
}
