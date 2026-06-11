import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { formatSingleConversation, getRecentConversations } from "../../core/history.js";
import { messages } from "../../core/i18n/index.js";
import { chatScope } from "../../core/project-manager.js";
import { buildQueueStatusLines } from "../../core/queue-status.js";
import { getPathBySession } from "../../core/sessionPathMap.js";
import { normalizeError } from "../../shared/utils/error.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { buildControlKeyboard, buildProjectKeyboard } from "./keyboards.js";
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
    const buttons = await aliveProjectButtons(
      deps,
      chatScope("telegram", String(ctx.chat?.id ?? 0)),
    );
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
  const body = buildQueueStatusLines(deps, "telegram").join("\n");
  await reply(ctx, "queue", messages("telegram").queueTitle, { body });
}
