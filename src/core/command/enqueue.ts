import { randomUUID } from "node:crypto";
import type { Channel, MessageQueue } from "./queue.js";

/** A unique-enough id for a queued message (timestamp + random suffix). */
export function newMessageId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/** The message's settlement callbacks — pure I/O of one adapter's reply surface. */
export interface MessageCallbacks {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  notify?: ((text: string) => void) | undefined;
}

/**
 * Acks the caller fires by the queue's verdict. `accepted` always runs on a
 * successful enqueue; `duplicate` runs first when the message was deduped
 * (dedup still acks success, but a blocked scope can settle here); `full` runs
 * instead when the queue rejected the message.
 */
export interface EnqueueAcks {
  accepted: (queueSizeBefore: number) => void | Promise<void>;
  full: () => void | Promise<void>;
  duplicate?: (() => void | Promise<void>) | undefined;
}

export interface EnqueueRequest {
  queue: MessageQueue;
  session: string;
  chatId: string | number;
  channel: Channel;
  action: string;
  text: string;
  callbacks: MessageCallbacks;
}

/**
 * Shared enqueue choreography for both adapters. Snapshots the queue depth,
 * enqueues with a fresh id, then routes the verdict:
 *  - false      → acks.full()
 *  - "duplicate"→ acks.duplicate?.() then acks.accepted()  (dedup acks success)
 *  - "queued"   → acks.accepted()
 *
 * The adapter owns the message callbacks (its reply surface) and the ack I/O;
 * this owns only the ordering and the received-vs-queued decision both channels
 * were duplicating. Returns the queue's verdict.
 */
export async function enqueueMessage(
  req: EnqueueRequest,
  acks: EnqueueAcks,
): Promise<"queued" | "duplicate" | false> {
  const queueSizeBefore = req.queue.size(req.session);
  const verdict = req.queue.enqueue({
    id: newMessageId(),
    text: req.text,
    chatId: req.chatId,
    channel: req.channel,
    sessionName: req.session,
    action: req.action,
    resolve: req.callbacks.resolve,
    reject: req.callbacks.reject,
    notify: req.callbacks.notify,
  });

  if (!verdict) {
    await acks.full();
    return false;
  }
  if (verdict === "duplicate") {
    await acks.duplicate?.();
  }
  await acks.accepted(queueSizeBefore);
  return verdict;
}
