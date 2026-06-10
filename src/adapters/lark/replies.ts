import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { logger } from "../../shared/utils/logger.js";
import { textOrPlaceholder } from "./format.js";

/** Send a plain text/markdown reply. Never throws — failures are logged and
 * swallowed so they cannot bubble into the channel's message handler. */
export async function sendText(
  channel: LarkChannel,
  chatId: string,
  output: string,
): Promise<void> {
  try {
    await channel.send(chatId, { markdown: textOrPlaceholder(output) });
  } catch (err) {
    logger.error(
      `[lark] sendText failed chat=${chatId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Send an interactive card reply, returning the sent message id so the card can
 * later be updated. Best-effort: failures are logged and swallowed. */
export async function sendCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
): Promise<string | undefined> {
  try {
    const r = await channel.send(chatId, { card });
    return r.messageId;
  } catch (err) {
    logger.error(
      `[lark] sendCard failed chat=${chatId}: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}
