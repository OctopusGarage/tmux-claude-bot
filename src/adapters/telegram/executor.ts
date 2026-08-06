import type { Context } from "grammy";
import { planMessageAction } from "../../core/command/action-plan.js";
import type { MessageAction } from "../../core/command/actions.js";
import { executeMessage } from "../../core/command/dispatch.js";
import { enqueueMessage, planQueuedAck } from "../../core/command/enqueue.js";
import { QueueCancelledError, type QueuedMessage } from "../../core/command/queue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { sessionShortId } from "../../shared/utils/hash.js";
import { createLogger } from "../../shared/utils/logger.js";
import { buildQueueCancelKeyboard, buildStartPickerKeyboard } from "./keyboards.js";
import { MSG } from "./messages.js";
import { reply } from "./replies.js";
import { requireSession } from "./session.js";

const log = createLogger("telegram.executor");

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
            log.info(`resolve callback fired session=${session} output_len=${output.length}`);
            void reply(ctx, "info", output, { session, replyTo });
          }),
        reject: (err: Error) => {
          log.error("queued action reject fired", { session, err });
          // A user-initiated cancel is not a failure — confirm it plainly (🗑),
          // not with the error tone. Mirrors Lark's QueueCancelledError branch.
          const tone = err instanceof QueueCancelledError ? "ok" : "err";
          const head = err instanceof QueueCancelledError ? `🗑 ${err.message}` : err.message;
          void reply(ctx, tone, head, { session, replyTo });
        },
      },
    },
    {
      accepted: async (queueSizeBefore, msgId) => {
        log.info(`enqueued action=${action} session=${session} queueSizeBefore=${queueSizeBefore}`);
        const plan = planQueuedAck(queueSizeBefore, action, msgId);
        if (plan.kind === "received") {
          await reply(ctx, "ok", m.ackReceived, { session });
        } else if (plan.kind === "cancellable") {
          // A still-waiting text message can be cancelled (❌) or rewritten (reply
          // to this ack) before it's typed in.
          const replyMarkup = buildQueueCancelKeyboard(sessionShortId(session), plan.msgId);
          const ackId = await reply(ctx, "queued", m.queuedAt(queueSizeBefore), {
            session,
            replyMarkup,
          });
          if (ackId !== null) deps.queue.setQueueAck(session, plan.msgId, String(ackId));
        } else {
          await reply(ctx, "queued", m.queuedAt(queueSizeBefore), { session });
        }
      },
      full: async () => {
        log.warn(`queue full session=${session} max=${deps.queue.getMaxSize()}`);
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
    const fromReply = replyTarget.resolve(replyToMsg.message_id);
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

  const planned = await planMessageAction({
    deps,
    action,
    session,
    text: text ?? action,
    confirmed: true,
  });

  if (planned.kind === "immediate") {
    const result = await executeMessage(
      { sessionName: session, action: planned.action, text, id: "" } as QueuedMessage,
      deps,
    );
    await reply(ctx, "info", result, { session, replyTo, replyTarget });
    return;
  }

  if (planned.kind === "already-running") {
    await reply(ctx, "ok", messages("telegram").agentAlreadyRunning, {
      session,
      replyTo,
      replyTarget,
    });
    return;
  }

  if (planned.kind === "pick-start-command") {
    await reply(ctx, "info", messages("telegram").startPickerPrompt, {
      session,
      replyTo,
      replyTarget,
      replyMarkup: buildStartPickerKeyboard(
        deps.config.startCommands,
        sessionShortId(session),
        planned.action,
      ),
    });
    return;
  }

  if (planned.kind === "queued") {
    await enqueueSessionCommand(ctx, deps, session, planned.action, planned.text, replyTo);
  }
}
