import { JsonMapStore } from "../infra/json-map-store.js";
import { bindingForSession } from "./group-bindings.js";

export type ReplyTarget = { channel: "telegram" | "lark"; chatId: string };

const store = new JsonMapStore<ReplyTarget>("session_reply_target.json");

export function recordReplyTarget(session: string, target: ReplyTarget): void {
  store.set(session, target);
}

export function clearReplyTarget(session: string): void {
  store.delete(session);
}

export function resolveReplyTarget(session: string): ReplyTarget | null {
  const stored = store.get(session);
  if (stored) return stored;
  const bound = bindingForSession(session);
  if (bound) return { channel: "lark", chatId: bound.chatId };
  return null;
}
