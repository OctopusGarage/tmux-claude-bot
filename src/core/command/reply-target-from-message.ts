import type { ReplyTarget } from "../projects/session-reply-target.js";

export function replyTargetFromMessage(msg: {
  chatId: string | number;
  channel?: "telegram" | "lark" | undefined;
}): ReplyTarget | null {
  if (!msg.channel) return null;
  if (msg.chatId === "control") return null;
  return { channel: msg.channel, chatId: String(msg.chatId) };
}
