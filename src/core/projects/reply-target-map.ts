import { BoundedSessionMap } from "../infra/bounded-session-map.js";

/**
 * message id → session, so a reply to a bot message routes back to that session.
 * A thin typed factory over {@link BoundedSessionMap} (bounded, persisted, restart-
 * safe), shared by every adapter so reply-routing behaves identically — only the
 * key type (Telegram numeric id vs Lark string id), the cap, and the persistence
 * file differ per channel, and those are passed in.
 */
export interface ReplyTargetMap<K extends string | number> {
  record(messageId: K, session: string): void;
  resolve(messageId: K): string | undefined;
  removeSession(session: string): void;
  clear(): void;
}

export function createReplyTargetMap<K extends string | number>(opts: {
  max: number;
  file: string;
}): ReplyTargetMap<K> {
  const store = new BoundedSessionMap<K>(opts);
  return {
    record: (id, session) => store.record(id, session),
    resolve: (id) => store.resolve(id),
    removeSession: (session) => store.removeSession(session),
    clear: () => store.clear(),
  };
}
