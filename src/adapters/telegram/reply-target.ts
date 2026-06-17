import * as nodePath from "node:path";
import { BoundedSessionMap } from "../../core/infra/bounded-session-map.js";

/**
 * Telegram reply-target map: telegram message id → session. Replying to a bot
 * message is the only way Telegram users target a session other than the current
 * project, so it is persisted (next to the message queue under `.queue/`) and
 * survives a restart — see {@link BoundedSessionMap}. Thin adapter over the
 * shared store, keeping the `resolveReplyTarget`/null shape the handlers use.
 */
export interface ReplyTargetMap {
  record(telegramMessageId: number, sessionName: string): void;
  resolveReplyTarget(telegramMessageId: number): string | null;
  removeSession(sessionName: string): void;
  clear(): void;
}

const DATA_DIR = ".queue";
const FILE_NAME = "reply_target_map.json";
const MAX_ENTRIES = 100;

export function createReplyTargetMap(customDir?: string): ReplyTargetMap {
  const store = new BoundedSessionMap<number>({
    max: MAX_ENTRIES,
    file: nodePath.join(customDir ?? DATA_DIR, FILE_NAME),
  });
  return {
    record: (id, session) => store.record(id, session),
    resolveReplyTarget: (id) => store.resolve(id) ?? null,
    removeSession: (session) => store.removeSession(session),
    clear: () => store.clear(),
  };
}
