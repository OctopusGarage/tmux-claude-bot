import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { logger } from "../../shared/utils/logger.js";
import { sendCard } from "./replies.js";

/**
 * Managed cards — CardKit 2.0 card entities that can be updated in place.
 *
 * Plain `channel.updateCard` is unreliable for 2.0 cards (updates get
 * reordered or rejected). The reliable path is to create a card *entity*
 * via cardkit, send a message that references its card_id, and push every
 * later change through `cardkit.card.update` with a monotonically
 * increasing sequence number.
 *
 * The messageId→{cardId, sequence} map is per-process. Lost on restart,
 * which is fine — callers fall back to re-sending when `updateManagedCard`
 * returns false.
 */

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

const byMessageId = new Map<string, ManagedEntry>();

/**
 * Send a card as a managed CardKit entity so it can later be updated in
 * place via {@link updateManagedCard}. Never throws: any failure in the
 * cardkit path falls back to a plain (non-updatable) card send. Returns
 * the sent message id, or undefined if even the fallback failed.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
): Promise<string | undefined> {
  try {
    const created = await channel.rawClient.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(card) },
    });
    const cardId = created.data?.card_id;
    if (created.code !== 0 || !cardId) {
      throw new Error(`cardkit create failed: code=${created.code} msg=${created.msg}`);
    }

    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
    });
    const messageId = sent.data?.message_id;
    if (sent.code !== 0 || !messageId) {
      throw new Error(`message create failed: code=${sent.code} msg=${sent.msg}`);
    }

    byMessageId.set(messageId, { cardId, sequence: 0 });
    return messageId;
  } catch (err) {
    logger.warn(
      `[lark] managed card send failed, falling back to plain card chat=${chatId}: ${err instanceof Error ? err.message : err}`,
    );
    return sendCard(channel, chatId, card);
  }
}

/**
 * Update a managed card in place, identified by the messageId of the
 * message that carries it. Returns false when the message is not managed
 * (e.g. sent before a restart) or the update failed — callers should fall
 * back to sending a fresh card.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<boolean> {
  const entry = byMessageId.get(messageId);
  if (!entry) return false;
  entry.sequence += 1;
  try {
    const r = await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: {
        card: { type: "card_json", data: JSON.stringify(card) },
        sequence: entry.sequence,
      },
    });
    if (r.code !== 0) {
      throw new Error(`cardkit update failed: code=${r.code} msg=${r.msg}`);
    }
    return true;
  } catch (err) {
    logger.warn(
      `[lark] managed card update failed msg=${messageId} seq=${entry.sequence}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
