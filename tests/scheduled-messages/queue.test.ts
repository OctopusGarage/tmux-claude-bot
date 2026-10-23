import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MessageQueue, type QueuedMessage } from "../../src/core/command/queue.js";

it("deduplicates schedule identity while preserving intentional equal content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "schedule-queue-"));
  const queue = new MessageQueue(10, join(dir, "pending.json"));
  let finish: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  queue.setHandler(async () => {
    await wait;
  });
  const item = (id: string, dedupeKey?: string): QueuedMessage => ({
    id,
    dedupeKey,
    text: "same",
    chatId: "chat",
    sessionName: "managed_test",
    action: "text",
    origin: "user",
    channel: "telegram",
    ephemeral: true,
    resolve: () => {},
    reject: () => {},
  });
  expect(queue.enqueue(item("one", "scheduled:one"))).toBe("queued");
  expect(queue.enqueue(item("two", "scheduled:two"))).toBe("queued");
  expect(queue.enqueue(item("retry", "scheduled:one"))).toBe("duplicate");
  expect(queue.enqueue(item("normal"))).toBe("queued");
  expect(queue.enqueue(item("normal-retry"))).toBe("duplicate");
  finish();
  await wait;
  queue.clear();
  rmSync(dir, { recursive: true, force: true });
});
