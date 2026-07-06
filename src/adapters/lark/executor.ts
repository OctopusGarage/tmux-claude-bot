import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import type { MessageAction } from "../../core/command/actions.js";
import { executeMessage } from "../../core/command/dispatch.js";
import { enqueueMessage, planQueuedAck } from "../../core/command/enqueue.js";
import {
  type PersistedMessage,
  QueueCancelledError,
  type QueuedMessage,
} from "../../core/command/queue.js";
import { restoreMessage } from "../../core/command/restore.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { isProjectGroup } from "../../core/projects/group-bindings.js";
import { resolveTargetSession } from "../../core/projects/operator.js";
import { labelForSession } from "../../core/projects/project-label.js";
import { chatScope } from "../../core/projects/project-manager.js";
import {
  prepareUserPromptDelivery,
  userPromptQueueFields,
} from "../../core/read/user-prompt-intake.js";
import { createLogger } from "../../shared/utils/logger.js";
import { queueAckCard, recoveryCard, resultCard } from "./cards.js";
import { markDone, markWorking } from "./reactions.js";
import { sendCard, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

const log = createLogger("lark.executor");

/** "📂 <friendly project>" tag stamped on every reply so the user can see which
 * project session received it — mirrors the Telegram adapter's project line. */
function projectTag(session: string): string {
  return messages("lark").projectTag(labelForSession(session));
}

/**
 * Rehydrate a persisted Lark-channel message into a live QueuedMessage on boot,
 * so a bot restart resumes the backlog instead of dropping it (parity with
 * Telegram's createRestoredMessage). resolve/reject deliver the result through
 * the freshly-connected Lark channel, the same way enqueueLarkAction does.
 */
export function createLarkRestoredMessage(
  p: PersistedMessage,
  channel: LarkChannel,
): QueuedMessage {
  const chatId = String(p.chatId);
  const session = p.sessionName ?? "";
  return restoreMessage(
    p,
    "lark",
    (output) => {
      void (async () => {
        const mid = await sendCard(
          channel,
          chatId,
          resultCard(output, projectTag(session), isProjectGroup(chatId)),
        );
        if (mid) recordReplyTarget(mid, session);
      })();
    },
    (err) => {
      void sendCard(
        channel,
        chatId,
        recoveryCard(
          `${messages("lark").errorPrefix(err.message)}\n${projectTag(session)}`,
          isProjectGroup(chatId),
        ),
      );
    },
  );
}

export async function resolveSession(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  sessionOverride?: string,
  operatorFallbackOk = false,
): Promise<string | null> {
  const resolvedSession =
    sessionOverride ?? (await deps.currentProject.get(chatScope("lark", chatId)));
  const session = resolveTargetSession(
    resolvedSession,
    deps.config.homeOperator.enabled && operatorFallbackOk,
    deps.config.projectSessionPrefix,
  );
  if (!session) {
    // No "/" discovery on Feishu — give buttons (projects/recent via the panel)
    // instead of a text hint pointing at commands they'd have to type.
    await sendCard(
      channel,
      chatId,
      recoveryCard(messages("lark").noCurrentProject, isProjectGroup(chatId)),
    );
    return null;
  }
  return session;
}

/**
 * Enqueue any action (text, start, restart, exit) with acks.
 * Resolves the current session, enqueues the message, and sends
 * "received" / "queued" / queue-full replies.
 */
export async function enqueueLarkAction(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  messageId: string,
  action: MessageAction,
  text: string,
  sessionOverride?: string,
  operatorFallbackOk = false,
  preview: "text" | "voice" = "text",
): Promise<void> {
  const session = await resolveSession(channel, deps, chatId, sessionOverride, operatorFallbackOk);
  if (!session) {
    return;
  }

  const m = messages("lark");
  const tag = projectTag(session);
  const prepared =
    action === "text"
      ? await prepareUserPromptDelivery("lark", text, preview)
      : ({ ok: true, text } as const);
  if (!prepared.ok) {
    await sendText(channel, chatId, `${m.promptTranslateFailed}\n${tag}`);
    return;
  }
  if (action === "text" && "preview" in prepared) {
    if (prepared.preview.kind === "voice") {
      await sendText(channel, chatId, m.voiceHeard(prepared.preview.sourceText));
    } else if (prepared.preview.kind === "voice-translated") {
      await sendText(
        channel,
        chatId,
        m.voiceHeardTranslated(prepared.preview.sourceText, prepared.preview.deliveredText),
      );
    } else if (prepared.preview.kind === "text-translated") {
      await sendText(
        channel,
        chatId,
        `${m.promptTranslatedSent(prepared.preview.from, prepared.preview.to)}\n${tag}`,
      );
    }
  }
  await enqueueMessage(
    {
      queue: deps.queue,
      session,
      chatId,
      channel: "lark",
      action,
      ...(action === "text" && "preview" in prepared
        ? userPromptQueueFields(prepared)
        : { text: prepared.text }),
      callbacks: {
        resolve: (output) => {
          log.info(`resolve session=${session} output_len=${output.length}`);
          void markDone(channel, messageId);
          void (async () => {
            // Only natural-language Claude results carry the control buttons; every
            // other action (start/restart/exit) replies as plain text. Mirrors
            // Telegram, where the control keyboard rides only on the NL result.
            if (action === "text") {
              const mid = await sendCard(
                channel,
                chatId,
                resultCard(output, projectTag(session), isProjectGroup(chatId)),
              );
              if (mid) {
                recordReplyTarget(mid, session);
              }
            } else {
              await sendText(channel, chatId, `${output}\n\n${projectTag(session)}`);
            }
          })();
        },
        notify: (text) => {
          void sendText(channel, chatId, `${text}\n\n${projectTag(session)}`);
        },
        reject: (err) => {
          log.error("queued action reject fired", { session, err });
          // A user-initiated cancel is not a failure — confirm it plainly, no
          // start/restart recovery surface.
          if (err instanceof QueueCancelledError) {
            void sendText(channel, chatId, `🗑 ${err.message}\n${projectTag(session)}`);
            return;
          }
          // Errors often mean Claude died / isn't running — surface start/restart.
          void sendCard(
            channel,
            chatId,
            recoveryCard(
              `${messages("lark").errorPrefix(err.message)}\n${projectTag(session)}`,
              isProjectGroup(chatId),
            ),
          );
        },
      },
    },
    {
      accepted: async (queueSizeBefore, msgId) => {
        log.info(`enqueued action=${action} session=${session} queueSizeBefore=${queueSizeBefore}`);
        void markWorking(channel, messageId);
        // Mirror Telegram's tone emoji (✅ received / ⏳ queued) so both channels
        // read the same — Feishu has no tone layer, so it's stamped here.
        const plan = planQueuedAck(queueSizeBefore, action, msgId);
        if (plan.kind === "received") {
          await sendText(channel, chatId, `✅ ${m.ackReceived}\n${tag}`);
        } else if (plan.kind === "cancellable") {
          // A still-waiting text message carries a ❌ to cancel it, and a reply to
          // this ack rewrites it — both before it's typed in.
          const mid = await sendCard(
            channel,
            chatId,
            queueAckCard(`⏳ ${m.queuedAt(queueSizeBefore)}\n${tag}`, session, plan.msgId),
          );
          if (mid) deps.queue.setQueueAck(session, plan.msgId, mid);
        } else {
          await sendText(channel, chatId, `⏳ ${m.queuedAt(queueSizeBefore)}\n${tag}`);
        }
      },
      full: async () => {
        log.warn(`queue full session=${session} max=${deps.queue.getMaxSize()}`);
        await sendText(channel, chatId, `⚠️ ${m.queueFull(deps.queue.getMaxSize())}\n${tag}`);
      },
    },
  );
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
  operatorFallbackOk = false,
): Promise<void> {
  const session = await resolveSession(channel, deps, chatId, sessionOverride, operatorFallbackOk);
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
    log.error("immediate action failed", { session, data: { action }, err });
    await sendCard(
      channel,
      chatId,
      recoveryCard(
        `${messages("lark").errorPrefix(errMsg)}\n${projectTag(session)}`,
        isProjectGroup(chatId),
      ),
    );
  }
}
