import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("lark.reactions");

const WORKING = "OnIt";
const DONE = "DONE";

/** Add the "working" reaction to a message. Best-effort: never throws. */
export async function markWorking(channel: LarkChannel, messageId: string): Promise<void> {
  try {
    await channel.addReaction(messageId, WORKING);
  } catch (err) {
    log.warn(
      `addReaction working failed msg=${messageId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Swap working->done on completion. Best-effort: never throws. */
export async function markDone(channel: LarkChannel, messageId: string): Promise<void> {
  try {
    await channel.removeReactionByEmoji(messageId, WORKING);
  } catch {
    /* ignore */
  }
  try {
    await channel.addReaction(messageId, DONE);
  } catch (err) {
    log.warn(
      `addReaction done failed msg=${messageId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
