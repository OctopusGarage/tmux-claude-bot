import { createReplyTargetMap } from "../../core/projects/reply-target-map.js";
import { appStateFile } from "../../shared/state-dir.js";

/**
 * Lark reply-target map: lark message id → session, so a reply to a
 * session-bound bot message routes back to that session. Same mechanism as
 * Telegram (Lark delivers `replyToMessageId`); the difference from Telegram is
 * one of *priority*, not capability: on Lark the primary way to target a session
 * is per-group workspace binding, so reply-routing is a secondary path here. Built
 * on the shared {@link createReplyTargetMap} core factory (bounded + persisted);
 * exposed as module functions since the Lark adapter resolves it as a singleton.
 */
const MAX = 500;
const map = createReplyTargetMap<string>({
  max: MAX,
  file: appStateFile("lark_reply_target_map.json"),
});

export function recordReplyTarget(messageId: string, session: string): void {
  map.record(messageId, session);
}

export function resolveReplyTarget(messageId: string): string | undefined {
  return map.resolve(messageId);
}

/** Forget all entries for a session (e.g. when its project is removed). */
export function removeReplyTargetSession(session: string): void {
  map.removeSession(session);
}
