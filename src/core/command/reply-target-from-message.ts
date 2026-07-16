import type { ReplyTarget } from "../projects/session-reply-target.js";

export function replyTargetFromMessage(msg: {
  chatId: string | number;
  channel?: "telegram" | "lark" | "control" | undefined;
}): ReplyTarget | null {
  if (!msg.channel || msg.channel === "control") return null;
  if (msg.chatId === "control") return null;
  return { channel: msg.channel, chatId: String(msg.chatId) };
}
