import * as nodePath from "node:path";
import {
  type ReplyTargetMap as CoreReplyTargetMap,
  createReplyTargetMap as createCore,
} from "../../core/projects/reply-target-map.js";

/**
 * Telegram reply-target map: telegram message id → session. Replying to a bot
 * message is the only way Telegram users target a session other than the current
 * project, so it is persisted (next to the message queue under `.queue/`) and
 * survives a restart. Thin wrapper over the shared {@link createCore} core factory —
 * only the key type (number), cap, and file are Telegram-specific.
 */
export type ReplyTargetMap = CoreReplyTargetMap<number>;

const DATA_DIR = ".queue";
const FILE_NAME = "reply_target_map.json";
const MAX_ENTRIES = 100;

export function createReplyTargetMap(customDir?: string): ReplyTargetMap {
  return createCore<number>({
    max: MAX_ENTRIES,
    file: nodePath.join(customDir ?? DATA_DIR, FILE_NAME),
  });
}
