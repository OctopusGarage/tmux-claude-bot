import type { Bot, Context } from "grammy";
import { getImmediateActions } from "../../core/command/action-registry.js";
import { executeMessage, type MessageAction } from "../../core/command/dispatch.js";
import { enqueueMessage } from "../../core/command/enqueue.js";
import type { PersistedMessage, QueuedMessage } from "../../core/command/queue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { logger } from "../../shared/utils/logger.js";
import { MSG } from "./messages.js";
import { reply, send } from "./replies.js";
import { requireSession } from "./session.js";

// Single source of truth (core/action-registry) — same set Lark derives, so the
// two adapters can't drift (telegram used to omit `tab`).
const IMMEDIATE_ACTIONS = getImmediateActions();

export async function enqueueSessionCommand(
  ctx: Context,
  deps: HandlerDeps,
  session: string,
  action: MessageAction,
  text?: string,
  replyTo?: number,
  onResolve?: (output: string) => void,
): Promise<void> {
  const m = messages("telegram");
  await enqueueMessage(
    {
      queue: deps.queue,
      session,
      chatId: ctx.chat?.id ?? 0,
      channel: "telegram",
      action,
      text: text ?? action,
      callbacks: {
        resolve:
          onResolve ??
          ((output: string) => {
            logger.info(
              `[executor] resolve callback fired session=${session} output_len=${output.length}`,
            );
            void reply(ctx, "info", output, { session, replyTo });
          }),
        reject: (err: Error) => {
          logger.error(`[executor] reject callback fired session=${session} err=${err.message}`);
          void reply(ctx, "err", `${err.message}`, { session, replyTo });
        },
      },
    },
    {
      accepted: async (queueSizeBefore) => {
        logger.info(
          `[executor] enqueued action=${action} session=${session} queueSizeBefore=${queueSizeBefore}`,
        );
        if (queueSizeBefore === 0) {
          await reply(ctx, "ok", m.ackReceived, { session });
        } else {
          await reply(ctx, "queued", m.queuedAt(queueSizeBefore), { session });
        }
      },
      full: async () => {
        logger.warn(`[executor] queue full session=${session} max=${deps.queue.getMaxSize()}`);
        await reply(ctx, "err", MSG.queueFull(deps.queue.getMaxSize()), { session });
      },
    },
  );
}

export async function handleQueuedCommand(
  ctx: Context,
  deps: HandlerDeps,
  action: MessageAction,
  text?: string,
  replyTarget?: ReturnType<typeof import("./reply-target.js").createReplyTargetMap>,
): Promise<void> {
  const replyToMsg = ctx.message?.reply_to_message;
  let session: string | null = null;
  if (replyToMsg && replyTarget) {
    const fromReply = replyTarget.resolveReplyTarget(replyToMsg.message_id);
    if (fromReply) session = fromReply;
  }
  if (!session) {
    session = await requireSession(deps, ctx.chat?.id ?? 0);
  }
  if (!session) {
    await reply(ctx, "err", MSG.noSession, {
      replyTarget,
    });
    return;
  }
  const replyTo = ctx.message?.message_id;

  if (IMMEDIATE_ACTIONS.has(action)) {
    const result = await executeMessage(
      { sessionName: session, action, text, id: "" } as QueuedMessage,
      deps,
    );
    await reply(ctx, "info", result, { session, replyTo, replyTarget });
    return;
  }

  await enqueueSessionCommand(ctx, deps, session, action, text, replyTo);
}

export function createRestoredMessage(p: PersistedMessage, bot: Bot): QueuedMessage {
  return {
    id: p.id,
    text: p.text,
    chatId: p.chatId,
    sessionName: p.sessionName,
    action: p.action,
    channel: "telegram",
    resolve: (output: string) => {
      void send(bot, Number(p.chatId), "recover", "Recovered", {
        session: p.sessionName,
        body: output,
        code: true,
      });
    },
    reject: (err: Error) => {
      void send(bot, Number(p.chatId), "err", `Recovered failed: ${err.message}`, {
        session: p.sessionName,
      });
    },
  };
}
