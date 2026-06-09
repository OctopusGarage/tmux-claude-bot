import type { Context } from "grammy";
import { formatSingleConversation, getRecentConversations } from "../services/history.js";
import type { ReplyTargetMap } from "../services/reply-target.js";
import { getPathBySession } from "../services/sessionPathMap.js";
import type { HandlerDeps } from "../types.js";
import { normalizeError } from "../utils/error.js";
import { sessionShortId } from "../utils/hash.js";
import { truncate } from "../utils/string.js";
import { buildControlKeyboard, buildProjectKeyboard } from "./keyboards.js";
import { projectLabel } from "./project-label.js";
import { aliveProjectButtons } from "./project-ops.js";
import { reply } from "./replies.js";

/**
 * Read-side renderers: fetch state (tmux pane, conversation history, queue) and
 * render it into a Telegram reply. No mutation — these only display. Kept apart
 * from command/callback wiring so the "what the user sees" lives in one place.
 */

/** The alive-projects list (tappable switch/delete keyboard, no body text). */
export async function sendAliveList(ctx: Context, deps: HandlerDeps): Promise<void> {
  try {
    const buttons = await aliveProjectButtons(deps);
    if (buttons.length === 0) {
      await reply(ctx, "list", "没有活跃项目\n\n用 /add_project <路径> 新建一个");
      return;
    }
    await reply(ctx, "list", `活跃项目 (${buttons.length})`, {
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
      await reply(ctx, "view", "（空）", { session, replyMarkup: keyboard, replyTarget });
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
      await reply(ctx, "warn", "缺少项目路径映射 · 先用 /add_project 建立", {
        session,
        replyTarget,
      });
      return;
    }
    const configRoot = await deps.configResolver.resolveConfigRoot(session);
    const rounds = await getRecentConversations(projectPath, configRoot);
    if (rounds.length === 0) {
      await reply(ctx, "info", "没有找到对话历史", { session, replyTarget });
      return;
    }
    if (index >= rounds.length) {
      await reply(ctx, "warn", `只有 ${rounds.length} 条对话记录`, { session, replyTarget });
      return;
    }
    const round = rounds[index];
    if (round === undefined) return;
    const body = formatSingleConversation(round, index, rounds.length);
    await reply(ctx, "view", "历史记录", {
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
  lines.push(`━━ 🌐 全局队列 ━━`);
  lines.push(`排队中： ${globalQueue.length} | 处理中： ${globalProcessing ? "🟢" : "🔴"}`);
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
    lines.push(`\n━━ 会话队列 ━━`);
    lines.push(`没有活跃的会话队列`);
  } else {
    for (const sessionName of sessionNames.sort()) {
      const queueItems = deps.queue.getSessionQueue(sessionName);
      const isProcessing = deps.queue.isSessionProcessing(sessionName);
      const currentMsg = deps.queue.getCurrentSessionMessage(sessionName);
      const lastAt = deps.queue.getLastProcessedAt(sessionName);
      const name = projectLabel(sessionName, getPathBySession(sessionName) ?? undefined);
      lines.push(`\n━━ 📂 ${name} ━━`);
      lines.push(`排队中： ${queueItems.length} | 处理中： ${isProcessing ? "🟢" : "🔴"}`);
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
        lines.push(`  上次完成： ${secondsAgo}s 前`);
      }
    }
  }

  await reply(ctx, "queue", "队列状态", { body: lines.join("\n") });
}
