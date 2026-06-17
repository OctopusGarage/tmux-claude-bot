import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { executeMessage, type MessageAction } from "../../core/command/dispatch.js";
import { enqueueMessage } from "../../core/command/enqueue.js";
import type { QueuedMessage } from "../../core/command/queue.js";
import type { HandlerDeps } from "../../core/deps.js";
import { messages } from "../../core/i18n/index.js";
import { isProjectGroup } from "../../core/projects/group-bindings.js";
import { projectLabel } from "../../core/projects/project-label.js";
import { chatScope } from "../../core/projects/project-manager.js";
import { getPathBySession } from "../../core/projects/sessionPathMap.js";
import { logger } from "../../shared/utils/logger.js";
import { recoveryCard, resultCard } from "./cards.js";
import { markDone, markWorking } from "./reactions.js";
import { sendCard, sendText } from "./replies.js";
import { recordReplyTarget } from "./reply-target.js";

/** "📂 <friendly project>" tag stamped on every reply so the user can see which
 * tmux session received it — mirrors the Telegram adapter's project line. */
function projectTag(session: string): string {
  return messages("lark").projectTag(projectLabel(session, getPathBySession(session) ?? undefined));
}

export async function resolveSession(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  sessionOverride?: string,
): Promise<string | null> {
  const session = sessionOverride ?? (await deps.currentProject.get(chatScope("lark", chatId)));
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
 *
 * `onSettled` fires exactly once when the message can no longer produce a
 * result: run completed (resolve), run failed (reject), or it never entered
 * the queue (no session / queue full / deduped). Used by the text debounce
 * to unblock its scope.
 */
export async function enqueueLarkAction(
  channel: LarkChannel,
  deps: HandlerDeps,
  chatId: string,
  messageId: string,
  action: MessageAction,
  text: string,
  sessionOverride?: string,
  onSettled?: () => void,
): Promise<void> {
  const session = await resolveSession(channel, deps, chatId, sessionOverride);
  if (!session) {
    onSettled?.();
    return;
  }

  const m = messages("lark");
  const tag = projectTag(session);
  await enqueueMessage(
    {
      queue: deps.queue,
      session,
      chatId,
      channel: "lark",
      action,
      text,
      callbacks: {
        resolve: (output) => {
          logger.info(`[lark] resolve session=${session} output_len=${output.length}`);
          onSettled?.();
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
          logger.error(`[lark] reject session=${session} err=${err.message}`);
          onSettled?.();
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
      accepted: async (queueSizeBefore) => {
        logger.info(
          `[lark] enqueued action=${action} session=${session} queueSizeBefore=${queueSizeBefore}`,
        );
        void markWorking(channel, messageId);
        // Mirror Telegram's tone emoji (✅ received / ⏳ queued) so both channels
        // read the same — Feishu has no tone layer, so it's stamped here.
        const ack =
          queueSizeBefore === 0 ? `✅ ${m.ackReceived}` : `⏳ ${m.queuedAt(queueSizeBefore)}`;
        await sendText(channel, chatId, `${ack}\n${tag}`);
      },
      full: async () => {
        logger.warn(`[lark] queue full session=${session} max=${deps.queue.getMaxSize()}`);
        onSettled?.();
        await sendText(channel, chatId, `⚠️ ${m.queueFull(deps.queue.getMaxSize())}\n${tag}`);
      },
      // Dropped without ever firing resolve/reject — settle now so a blocked
      // debounce scope can't be jammed forever. The accepted ack still goes out
      // (dedup has always pretended success to the sender).
      duplicate: () => {
        onSettled?.();
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
