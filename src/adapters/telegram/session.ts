import type { Context } from "grammy";
import type { HandlerDeps } from "../../core/deps.js";
import { chatScope } from "../../core/projects/project-manager.js";
import type { ReplyTargetMap } from "./reply-target.js";

/** The current project's session for a specific chat, but only if its tmux pane is alive. */
export async function requireSession(
  deps: HandlerDeps,
  chatId: string | number,
): Promise<string | null> {
  const session = await deps.currentProject.get(chatScope("telegram", String(chatId)));
  if (!session) return null;
  const exists = await deps.bridge.hasSession(session);
  if (!exists) return null;
  const alive = await deps.bridge.isPaneAlive(session);
  if (!alive) return null;
  return session;
}

/**
 * Resolve which session a command targets: the session of the bot message it
 * replies to, otherwise the (alive) current project for this chat.
 */
export async function resolveSessionFromReply(
  ctx: Context,
  replyTarget: ReplyTargetMap,
  deps: HandlerDeps,
): Promise<string | null> {
  const replyToId = ctx.message?.reply_to_message?.message_id;
  const fromReply = replyToId !== undefined ? replyTarget.resolveReplyTarget(replyToId) : null;
  return fromReply ?? requireSession(deps, ctx.chat?.id ?? 0);
}
