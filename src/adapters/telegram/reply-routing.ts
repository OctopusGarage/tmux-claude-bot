import type { ReplyTargetMap } from "./reply-target.js";

/**
 * Resolve which tmux session an incoming message targets. If the user is
 * replying to one of the bot's earlier messages, route to that message's
 * session; otherwise fall back to the current project. Shared by the text and
 * voice handlers so both honor reply-to routing identically.
 */
export function resolveSessionForMessage(
  replyToMessageId: number | undefined,
  replyTarget: ReplyTargetMap,
  fallbackSession: string | null,
): string | null {
  if (replyToMessageId !== undefined) {
    const fromReply = replyTarget.resolve(replyToMessageId);
    if (fromReply) return fromReply;
  }
  return fallbackSession;
}
