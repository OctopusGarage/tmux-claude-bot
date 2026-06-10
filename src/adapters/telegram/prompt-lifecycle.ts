import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { logger } from "../../shared/utils/logger.js";
import { looksLikeTerminalOutput } from "./format.js";
import { buildControlKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import { startProgress } from "./progress.js";
import { REACTION, type ReactionApi, reactToMessage } from "./reactions.js";
import { composeMessage, reply } from "./replies.js";
import type { ReplyTargetMap } from "./reply-target.js";
import { startTyping } from "./typing.js";

const PROGRESS_TICK_MS = 5000;
// Tasks longer than this likely finished while the user was away. The result is
// delivered via an in-place edit (which Telegram does NOT push-notify), so we
// also send a short fresh message to trigger a notification.
const COMPLETION_PING_THRESHOLD_S = 60;

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

export function shouldSendCompletionPing(elapsed: number): boolean {
  return elapsed > COMPLETION_PING_THRESHOLD_S;
}

function thinkingText(session: string, queuePosition: number, elapsed?: number): string {
  if (queuePosition > 0) {
    return composeMessage("queued", messages("telegram").processingQueued(queuePosition), {
      session,
    }).text;
  }
  return composeMessage("queued", messages("telegram").processing, { session, elapsedS: elapsed })
    .text;
}

/**
 * Premium lifecycle for a prompt sent to Claude:
 *   👀 react (silent ack) → typing indicator + a live "处理中…" message that
 *   ticks elapsed time → on completion the message is edited in place into the
 *   formatted answer (prose vs. code chosen automatically) with a control
 *   keyboard, and the prompt gets a 👍 (or 😱 on failure).
 *
 * Tradeoff: the final answer arrives via an in-place edit, which Telegram does
 * not push-notify. The initial "处理中…" message does notify, signalling that
 * work started. If startProgress fails we fall back to a fresh reply (which
 * does notify).
 */
export async function runPromptWithProgress(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  text: string,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const chatId = ctx.chat?.id ?? 0;
  const userMsgId = ctx.message?.message_id;
  const startedAt = Date.now();
  // grammy types reaction emojis as a strict literal union; our REACTION values
  // are valid members, so a structural cast to the minimal interface is safe.
  const reactionApi = ctx.api as unknown as ReactionApi;

  if (userMsgId !== undefined) {
    void reactToMessage(reactionApi, chatId, userMsgId, REACTION.received);
  }

  const queuePosition = deps.queue.size(session);
  const replyExtra = userMsgId !== undefined ? { reply_to_message_id: userMsgId } : {};
  const progress = await startProgress(
    ctx.api,
    chatId,
    thinkingText(session, queuePosition),
    replyExtra,
  );
  const stopTyping = startTyping(ctx.api, chatId);

  let ticker: ReturnType<typeof setInterval> | undefined;
  if (progress) {
    ticker = setInterval(() => {
      void progress.update(thinkingText(session, 0, elapsedSeconds(startedAt)));
    }, PROGRESS_TICK_MS);
    (ticker as { unref?: () => void }).unref?.();
  }

  const cleanup = (): void => {
    stopTyping();
    if (ticker) clearInterval(ticker);
  };

  const queued = deps.queue.enqueue({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${randomUUID().slice(0, 6)}`,
    text,
    chatId,
    sessionName: session,
    action: "text",
    resolve: (output: string) => {
      cleanup();
      if (userMsgId !== undefined) {
        void reactToMessage(reactionApi, chatId, userMsgId, REACTION.done);
      }
      void deliverResult(ctx, session, output, elapsedSeconds(startedAt), progress, replyTarget);
    },
    reject: (err: Error) => {
      cleanup();
      if (userMsgId !== undefined) {
        void reactToMessage(reactionApi, chatId, userMsgId, REACTION.failed);
      }
      void deliverError(ctx, session, err, elapsedSeconds(startedAt), progress, replyTarget);
    },
  });

  if (!queued) {
    cleanup();
    logger.warn(`[lifecycle] queue full session=${session}`);
    await reply(ctx, "err", MSG.queueFull(deps.queue.getMaxSize()), {
      session,
      replyTarget,
    });
  }
}

async function deliverResult(
  ctx: Context,
  session: string,
  output: string,
  elapsed: number,
  progress: Awaited<ReturnType<typeof startProgress>>,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  const trimmed = output.trim();
  const isTerminal = looksLikeTerminalOutput(output);
  const head = messages("telegram").doneShort;
  const opts = trimmed
    ? { session, body: output, code: isTerminal, markdown: !isTerminal, elapsedS: elapsed }
    : { session, elapsedS: elapsed };
  const keyboard = buildControlKeyboard(sessionShortId(session));

  if (progress) {
    const { text, extra } = composeMessage("result", head, opts);
    const ok = await progress.finalize(text, { ...extra, reply_markup: keyboard });
    if (ok) {
      replyTarget.record(progress.messageId, session);
      // The in-place edit above is silent; nudge the user's device if the task
      // ran long enough that they probably walked away.
      if (shouldSendCompletionPing(elapsed)) {
        await reply(ctx, "result", messages("telegram").doneShort, {
          session,
          elapsedS: elapsed,
          replyTarget,
        });
      }
      return;
    }
  }
  // Fallback: progress message missing or its edit failed — deliver fresh.
  await reply(ctx, "result", head, { ...opts, replyMarkup: keyboard, replyTarget });
}

async function deliverError(
  ctx: Context,
  session: string,
  err: Error,
  elapsed: number,
  progress: Awaited<ReturnType<typeof startProgress>>,
  replyTarget: ReplyTargetMap,
): Promise<void> {
  if (progress) {
    const { text } = composeMessage("err", messages("telegram").failed, {
      session,
      body: err.message,
      elapsedS: elapsed,
    });
    const ok = await progress.finalize(text);
    if (ok) {
      replyTarget.record(progress.messageId, session);
      if (shouldSendCompletionPing(elapsed)) {
        await reply(ctx, "err", messages("telegram").failed, {
          session,
          elapsedS: elapsed,
          replyTarget,
        });
      }
      return;
    }
  }
  await reply(ctx, "err", messages("telegram").failed, {
    session,
    body: err.message,
    elapsedS: elapsed,
    replyTarget,
  });
}
