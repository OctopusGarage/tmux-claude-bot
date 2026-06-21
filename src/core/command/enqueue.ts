import { randomUUID } from "node:crypto";
import { currentLogContext } from "../../shared/utils/log-context.js";
import type { Channel, MessageQueue } from "./queue.js";

/** A unique-enough id for a queued message (timestamp + random suffix). */
export function newMessageId(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/** What a successful enqueue's ack should be — the one place the policy lives, so
 * the two adapters render the same decision and can't drift. A DISCRIMINATED result
 * so the "cancellable" case carries its msgId: the adapter can't reach for an id that
 * isn't there (a deduped / non-text item has none), with no redundant re-check.
 *  - received:    ran immediately (the queue was empty).
 *  - cancellable: queued behind others AND a text prompt with a real id → the ack
 *                 carries ❌-cancel / reply-to-rewrite controls bound to `msgId`.
 *  - queued:      queued, but a non-text action or a deduped message (no id) → a
 *                 plain ack, no controls to bind to a non-existent item.
 */
export type QueuedAck =
  | { kind: "received" }
  | { kind: "cancellable"; msgId: string }
  | { kind: "queued" };
export function planQueuedAck(queueSizeBefore: number, action: string, msgId?: string): QueuedAck {
  if (queueSizeBefore === 0) return { kind: "received" };
  if (action === "text" && msgId) return { kind: "cancellable", msgId };
  return { kind: "queued" };
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
 * (dedup still acks success); `full` runs instead when the queue rejected the
 * message.
 */
export interface EnqueueAcks {
  /** @param msgId the queued message's id — bind a per-item cancel/rewrite control
   * to it. UNDEFINED when the message was deduped (nothing was enqueued), so the
   * adapter must NOT attach controls that would target a non-existent item. */
  accepted: (queueSizeBefore: number, msgId?: string) => void | Promise<void>;
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
  const traceId = currentLogContext().traceId;
  const msgId = newMessageId();
  const verdict = req.queue.enqueue({
    id: msgId,
    text: req.text,
    chatId: req.chatId,
    channel: req.channel,
    sessionName: req.session,
    action: req.action,
    ...(traceId !== undefined && { traceId }),
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
  // A deduped message was NOT enqueued, so there is no real queue item to bind a
  // cancel/rewrite control to — withhold the id so the adapter renders a plain ack.
  await acks.accepted(queueSizeBefore, verdict === "duplicate" ? undefined : msgId);
  return verdict;
}
