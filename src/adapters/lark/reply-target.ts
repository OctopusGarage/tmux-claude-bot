/**
 * Bounded in-memory map of bot-message-id -> session, so a user reply to a
 * session-bound bot message routes back to that session instead of the current
 * project. Mirrors the Telegram reply-target map (here kept in-memory only:
 * Lark message ids are opaque strings and don't need cross-restart persistence).
 */
const MAX = 500;
const map = new Map<string, string>();

/** Remember that bot message `messageId` belongs to `session`, so a user reply
 * to it routes back to that session. Bounded (drops oldest) to avoid growth. */
export function recordReplyTarget(messageId: string, session: string): void {
  map.set(messageId, session);
  if (map.size > MAX) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
}

export function resolveReplyTarget(messageId: string): string | undefined {
  return map.get(messageId);
}

/** Forget all entries for a session (e.g. when its project is removed). */
export function removeReplyTargetSession(session: string): void {
  for (const [k, v] of map) if (v === session) map.delete(k);
}
