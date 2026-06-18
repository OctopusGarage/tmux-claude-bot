import { createLogger } from "../../shared/utils/logger.js";
import { timeApi } from "../../shared/utils/timing.js";

const log = createLogger("telegram.reactions");

/** Emoji reactions used to acknowledge message lifecycle without text noise. */
export const REACTION = {
  /** Message received and about to be processed. */
  received: "👀",
  /** Task finished successfully — the "like" the user asked for. */
  done: "👍",
  /** Task failed. */
  failed: "😱",
} as const;

export interface ReactionApi {
  setMessageReaction(
    chatId: number,
    messageId: number,
    reaction: Array<{ type: "emoji"; emoji: string }>,
  ): Promise<unknown>;
}

/**
 * React to a message with a single emoji. Reactions are pure polish, so any
 * failure (unsupported emoji, deleted message, old client) is logged and
 * swallowed — it must never interrupt the actual command flow.
 */
export async function reactToMessage(
  api: ReactionApi,
  chatId: number,
  messageId: number,
  emoji: string,
): Promise<void> {
  try {
    await timeApi(`setMessageReaction(${emoji})`, () =>
      api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]),
    );
  } catch (err) {
    log.warn(
      `failed to set ${emoji} on chat=${chatId} msg=${messageId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
