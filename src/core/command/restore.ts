import type { Channel } from "../projects/project-manager.js";
import type { PersistedMessage, QueuedMessage } from "./queue.js";

/**
 * Rehydrate a {@link PersistedMessage} into a {@link QueuedMessage} on boot, copying
 * every routing field verbatim. The ONE place this copy lives — so a new persisted
 * field (e.g. the `ackMsgId` reply-to-rewrite binding) is carried on every adapter
 * and can't be remembered on one side and silently dropped on the other. The
 * channel-specific result delivery is supplied by the caller as resolve/reject.
 */
export function restoreMessage(
  p: PersistedMessage,
  channel: Channel,
  resolve: (output: string) => void,
  reject: (err: Error) => void,
): QueuedMessage {
  return {
    id: p.id,
    text: p.text,
    chatId: p.chatId,
    sessionName: p.sessionName,
    action: p.action,
    channel,
    origin: p.origin,
    promptSource: p.promptSource,
    sourceText: p.sourceText,
    transform: p.transform,
    ackMsgId: p.ackMsgId,
    // Carry the ingress trace so a recovered message's execution logs still
    // correlate to its original trace instead of starting blank.
    traceId: p.traceId,
    resolve,
    reject,
  };
}
