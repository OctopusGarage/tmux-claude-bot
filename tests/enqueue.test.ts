import { describe, expect, it, vi } from "vitest";
import { enqueueMessage, newMessageId } from "../src/core/command/enqueue.js";
import type { MessageQueue } from "../src/core/command/queue.js";

/** A minimal MessageQueue stand-in: programmable verdict + captured enqueue arg. */
function fakeQueue(verdict: "queued" | "duplicate" | false, sizeBefore = 0) {
  const enqueue = vi.fn(() => verdict);
  const queue = { size: () => sizeBefore, enqueue } as unknown as MessageQueue;
  return { queue, enqueue };
}

const baseReq = (queue: MessageQueue) => ({
  queue,
  session: "s1",
  chatId: 1,
  channel: "telegram" as const,
  action: "text",
  text: "hi",
  callbacks: { resolve: () => {}, reject: () => {} },
});

describe("newMessageId", () => {
  it("produces distinct ids", () => {
    expect(newMessageId()).not.toBe(newMessageId());
  });
});

describe("enqueueMessage", () => {
  it("on success calls accepted with the prior queue depth, not full/duplicate", async () => {
    const { queue, enqueue } = fakeQueue("queued", 2);
    const accepted = vi.fn();
    const full = vi.fn();
    const duplicate = vi.fn();

    const verdict = await enqueueMessage(baseReq(queue), { accepted, full, duplicate });

    expect(verdict).toBe("queued");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledWith(2);
    expect(full).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("on a full queue calls full only", async () => {
    const { queue } = fakeQueue(false);
    const accepted = vi.fn();
    const full = vi.fn();

    const verdict = await enqueueMessage(baseReq(queue), { accepted, full });

    expect(verdict).toBe(false);
    expect(full).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
  });

  it("on a duplicate calls duplicate THEN accepted (dedup still acks success)", async () => {
    const { queue } = fakeQueue("duplicate", 0);
    const order: string[] = [];
    const accepted = vi.fn(() => void order.push("accepted"));
    const duplicate = vi.fn(() => void order.push("duplicate"));

    const verdict = await enqueueMessage(baseReq(queue), {
      accepted,
      full: vi.fn(),
      duplicate,
    });

    expect(verdict).toBe("duplicate");
    expect(order).toEqual(["duplicate", "accepted"]);
  });

  it("on a duplicate with no duplicate handler still acks accepted (telegram case)", async () => {
    const { queue } = fakeQueue("duplicate", 0);
    const accepted = vi.fn();

    const verdict = await enqueueMessage(baseReq(queue), { accepted, full: vi.fn() });

    expect(verdict).toBe("duplicate");
    expect(accepted).toHaveBeenCalledOnce();
  });
});
