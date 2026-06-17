import { BoundedSessionMap } from "../../core/infra/bounded-session-map.js";
import { appStateFile } from "../../shared/state-dir.js";

/**
 * Lark reply-target map: lark message id → session, so a reply to a
 * session-bound bot message routes back to that session. Same mechanism as
 * Telegram (Lark delivers `replyToMessageId`); the difference from Telegram is
 * one of *priority*, not capability: on Lark the primary way to target a session
 * is per-group workspace binding, so reply-routing is a secondary path here. It
 * is still persisted (see {@link BoundedSessionMap}) so it survives a restart
 * for parity — the tmux sessions outlive the bot, and this is independent of
 * Lark's not-yet-built queue restore.
 */
const MAX = 500;
const store = new BoundedSessionMap<string>({
  max: MAX,
  file: appStateFile("lark_reply_target_map.json"),
});

export function recordReplyTarget(messageId: string, session: string): void {
  store.record(messageId, session);
}

export function resolveReplyTarget(messageId: string): string | undefined {
  return store.resolve(messageId);
}

/** Forget all entries for a session (e.g. when its project is removed). */
export function removeReplyTargetSession(session: string): void {
  store.removeSession(session);
}
