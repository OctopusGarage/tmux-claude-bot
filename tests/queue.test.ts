import { describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/core/queue.js";

/** Poll until predicate is true or timeout. Replaces fixed-sleep coordination. */
async function waitFor(
  predicate: () => boolean,
  { timeout = 2000, interval = 5 } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: condition not met within timeout");
    await new Promise((r) => setTimeout(r, interval));
  }
}

const createTestMessage = (
  overrides: Partial<{
    id: string;
    text: string;
    chatId: number;
    sessionName: string | undefined;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = {},
) => ({
  action: "test" as const,
  id: "1",
  text: "default",
  chatId: 1,
  sessionName: "s1" as string | undefined,
  resolve: () => {},
  reject: () => {},
  ...overrides,
});

describe("MessageQueue", () => {
  describe("basic processing", () => {
    it("processes messages with handler", async () => {
      const queue = new MessageQueue(10);
      const results: string[] = [];

      queue.setHandler(async (msg) => {
        results.push(msg.text);
        msg.resolve("ok");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      queue.enqueue(createTestMessage({ id: "2", text: "b" }));

      await waitFor(() => results.length === 2);

      expect(results).toEqual(["a", "b"]);
    });

    it("rejects the message if the handler throws without settling (no hang)", async () => {
      // The handler contract is to settle the message itself; a handler that
      // throws without doing so must not leave the caller awaiting forever.
      const queue = new MessageQueue(10);
      queue.setHandler(async () => {
        throw new Error("boom");
      });

      let rejected: Error | undefined;
      queue.enqueue(createTestMessage({ id: "1", text: "a", reject: (e) => (rejected = e) }));

      await waitFor(() => rejected !== undefined);
      expect(rejected?.message).toBe("boom");
    });

    it("does not re-run the handler (tmux sends are not idempotent)", async () => {
      // The old retry loop would re-run a throwing handler up to 3x → triple
      // sendKeys. A throwing handler must run exactly once.
      const queue = new MessageQueue(10);
      let runs = 0;
      queue.setHandler(async () => {
        runs += 1;
        throw new Error("boom");
      });

      let rejected = false;
      queue.enqueue(createTestMessage({ id: "1", text: "a", reject: () => (rejected = true) }));

      await waitFor(() => rejected);
      // Give any stray retry a chance to fire before asserting it did not.
      await new Promise((r) => setTimeout(r, 50));
      expect(runs).toBe(1);
    });

    it("handles multiple messages in sequence", async () => {
      const queue = new MessageQueue(10);
      const results: string[] = [];

      queue.setHandler(async (msg) => {
        results.push(msg.text);
        msg.resolve("ok");
      });

      for (let i = 0; i < 5; i++) {
        queue.enqueue(createTestMessage({ id: String(i), text: String(i) }));
      }

      await waitFor(() => results.length === 5);

      expect(results).toEqual(["0", "1", "2", "3", "4"]);
    });

    it("rejects messages on handler error", async () => {
      vi.useFakeTimers();
      try {
        const queue = new MessageQueue(10);
        const rejections: string[] = [];

        queue.setHandler(async (msg) => {
          if (msg.text === "fail") {
            throw new Error("handler error");
          }
          msg.resolve("ok");
        });

        queue.enqueue({
          action: "test",
          id: "1",
          text: "ok",
          chatId: 1,
          sessionName: "s1",
          resolve: () => {},
          reject: (e) => rejections.push(e.message),
        });
        queue.enqueue({
          action: "test",
          id: "2",
          text: "fail",
          chatId: 1,
          sessionName: "s1",
          resolve: () => {},
          reject: (e) => rejections.push(e.message),
        });

        await vi.advanceTimersByTimeAsync(4000);

        expect(rejections).toContain("handler error");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("session isolation", () => {
    it("processes different sessions concurrently", async () => {
      const queue = new MessageQueue(10);
      const started: string[] = [];

      queue.setHandler(async (msg) => {
        started.push(msg.sessionName ?? "global");
        msg.resolve("ok");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: "sessionA" }));
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: "sessionB" }));

      await waitFor(() => started.includes("sessionA") && started.includes("sessionB"));

      expect(started).toContain("sessionA");
      expect(started).toContain("sessionB");
    });

    it("serializes same session messages", async () => {
      const queue = new MessageQueue(10);
      const order: string[] = [];

      // Use a latch to control when msg "a" finishes, giving us deterministic ordering assertions.
      let releaseMsgA: (() => void) | undefined;
      const msgABlocked = new Promise<void>((resolve) => {
        releaseMsgA = resolve;
      });

      queue.setHandler(async (msg) => {
        order.push(`start-${msg.text}`);
        if (msg.text === "a") {
          await msgABlocked;
        }
        order.push(`end-${msg.text}`);
        msg.resolve("ok");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: "sessionA" }));
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: "sessionA" }));

      // Wait until "a" has started — then assert "b" has NOT started yet (serial enforcement)
      await waitFor(() => order.includes("start-a"));
      expect(order).toContain("start-a");
      expect(order).not.toContain("start-b");

      // Release "a" so "b" can proceed
      releaseMsgA!();

      // Wait for both to complete in order
      await waitFor(() => order.length === 4);
      expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
    });

    it("resolves each message to its own callback", async () => {
      const queue = new MessageQueue(10);
      const replies: Record<string, string> = {};

      queue.setHandler(async (msg) => {
        msg.resolve(`reply-${msg.sessionName ?? "global"}`);
      });

      queue.enqueue({
        action: "test",
        id: "1",
        text: "a",
        chatId: 1,
        sessionName: "sessionA",
        resolve: (out) => {
          replies.A = out;
        },
        reject: () => {},
      });
      queue.enqueue({
        action: "test",
        id: "2",
        text: "b",
        chatId: 1,
        sessionName: "sessionB",
        resolve: (out) => {
          replies.B = out;
        },
        reject: () => {},
      });

      await waitFor(() => replies.A !== undefined && replies.B !== undefined);

      expect(replies.A).toBe("reply-sessionA");
      expect(replies.B).toBe("reply-sessionB");
    });
  });

  describe("global (non-session) messages", () => {
    it("processes global messages without session blocking", async () => {
      const queue = new MessageQueue(10);
      const results: string[] = [];

      queue.setHandler(async (msg) => {
        results.push(msg.text);
        await new Promise((r) => setTimeout(r, 30));
        msg.resolve("ok");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "session-msg" }));
      queue.enqueue(createTestMessage({ id: "2", text: "global-msg", sessionName: undefined }));

      // Global message should start immediately, not blocked by session s1
      await waitFor(() => results.includes("global-msg"));
      expect(results).toContain("global-msg");
    });

    it("serializes global messages", async () => {
      const queue = new MessageQueue(10);
      const order: string[] = [];

      // Use a latch to control when msg "a" finishes
      let releaseMsgA: (() => void) | undefined;
      const msgABlocked = new Promise<void>((resolve) => {
        releaseMsgA = resolve;
      });

      queue.setHandler(async (msg) => {
        order.push(`start-${msg.text}`);
        if (msg.text === "a") {
          await msgABlocked;
        }
        order.push(`end-${msg.text}`);
        msg.resolve("ok");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: undefined }));
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: undefined }));

      // Wait until "a" has started, then assert "b" has NOT started (serial)
      await waitFor(() => order.includes("start-a"));
      expect(order).toEqual(["start-a"]);

      // Release "a"
      releaseMsgA!();

      // Wait for both to complete
      await waitFor(() => order.length === 4);
      expect(order).toEqual(["start-a", "end-a", "start-b", "end-b"]);
    });

    it("reports correct global size", () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        msg.resolve("");
      });

      expect(queue.size()).toBe(0);
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: undefined }));
      expect(queue.size()).toBeLessThanOrEqual(1);
    });
  });

  describe("handler not set", () => {
    it("rejects messages when handler is not set", async () => {
      const queue = new MessageQueue(10);
      const rejections: string[] = [];

      queue.enqueue({
        action: "test",
        id: "1",
        text: "a",
        chatId: 1,
        sessionName: "s1",
        resolve: () => {},
        reject: (e) => rejections.push(e.message),
      });

      await waitFor(() => rejections.length > 0);

      expect(rejections).toContain("Queue handler not set");
      expect(queue.size("s1")).toBe(0);
    });
  });

  describe("process guard", () => {
    it("returns early when session is already processing", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 50));
        msg.resolve("");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      // Wait until session is actually processing before probing guard
      await waitFor(() => queue.isSessionProcessing("s1"));

      // Manually trigger processSession() while already processing
      const result = await (
        queue as unknown as { processSession(s: string): Promise<void> }
      ).processSession("s1");
      expect(result).toBeUndefined();
    });
  });

  describe("isEmpty and clear", () => {
    it("returns true when queue is empty", () => {
      const queue = new MessageQueue(10);
      expect(queue.isEmpty()).toBe(true);
    });

    it("returns false when queue has items blocked by processing session", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 100));
        msg.resolve("");
      });
      // First message starts processing session s1
      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      // Wait until processing has started so the lock is held
      await waitFor(() => queue.isSessionProcessing("s1"));
      // Second message for same session should stay in queue
      queue.enqueue(createTestMessage({ id: "2", text: "b" }));
      expect(queue.isEmpty()).toBe(false);
      expect(queue.size("s1")).toBe(1);
    });

    it("clears all queued messages", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 100));
        msg.resolve("");
      });
      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      // Wait until session is processing before enqueuing more
      await waitFor(() => queue.isSessionProcessing("s1"));
      queue.enqueue(createTestMessage({ id: "2", text: "b" }));
      queue.enqueue(createTestMessage({ id: "3", text: "c", sessionName: undefined }));
      expect(queue.size("s1")).toBe(1);
      expect(queue.size()).toBe(1); // only msg2 in queue; msg1 and msg3 are being processed
      queue.clear();
      expect(queue.isEmpty()).toBe(true);
      expect(queue.size()).toBe(0);
    });
  });

  describe("size and limits", () => {
    it("returns correct per-session queue size", () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        msg.resolve("");
      });

      expect(queue.size("s1")).toBe(0);
      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      expect(queue.size("s1")).toBeLessThanOrEqual(1);
    });

    it("returns correct total size across sessions and global", () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        msg.resolve("");
      });

      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: "s2" }));
      queue.enqueue(createTestMessage({ id: "3", text: "c", sessionName: undefined }));
      expect(queue.size()).toBeLessThanOrEqual(3);
    });

    it("rejects enqueue when session queue is full", () => {
      const queue = new MessageQueue(1);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 1000));
        msg.resolve("");
      });

      // processSession removes msg1 immediately, queue becomes empty
      expect(queue.enqueue(createTestMessage({ id: "1", text: "a" }))).toBe("queued");
      // queue is empty, msg2 can enter
      expect(queue.enqueue(createTestMessage({ id: "2", text: "b" }))).toBe("queued");
      // queue now has msg2, msg3 is rejected
      expect(queue.enqueue(createTestMessage({ id: "3", text: "c" }))).toBe(false);
    });

    it("rejects enqueue when global queue is full", () => {
      const queue = new MessageQueue(1);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 1000));
        msg.resolve("");
      });

      expect(queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: undefined }))).toBe(
        "queued",
      );
      expect(queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: undefined }))).toBe(
        "queued",
      );
      expect(queue.enqueue(createTestMessage({ id: "3", text: "c", sessionName: undefined }))).toBe(
        false,
      );
    });

    it("session limits are independent", () => {
      const queue = new MessageQueue(1);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 1000));
        msg.resolve("");
      });

      // s1 at capacity
      expect(queue.enqueue(createTestMessage({ id: "1", text: "a" }))).toBe("queued");
      expect(queue.enqueue(createTestMessage({ id: "2", text: "b" }))).toBe("queued");
      expect(queue.enqueue(createTestMessage({ id: "3", text: "c" }))).toBe(false);

      // s2 still has room
      expect(queue.enqueue(createTestMessage({ id: "4", text: "d", sessionName: "s2" }))).toBe(
        "queued",
      );
    });
  });

  describe("isEmpty edge cases", () => {
    it("returns false when global queue has items", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 500));
        msg.resolve("");
      });
      // First global message starts processing
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: undefined }));
      // Wait until global processing has started
      await waitFor(() => queue.isGlobalProcessing());
      // Second global message enqueued while processingGlobal is true
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: undefined }));
      expect(queue.isEmpty()).toBe(false);
    });
  });

  describe("processing state helpers", () => {
    it("reports session processing state", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 100));
        msg.resolve("");
      });
      expect(queue.isSessionProcessing("s1")).toBe(false);
      queue.enqueue(createTestMessage({ id: "1", text: "a" }));
      await waitFor(() => queue.isSessionProcessing("s1"));
      expect(queue.isSessionProcessing("s1")).toBe(true);
      await waitFor(() => !queue.isSessionProcessing("s1"), { timeout: 2000 });
      expect(queue.isSessionProcessing("s1")).toBe(false);
    });

    it("reports global processing state", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 100));
        msg.resolve("");
      });
      expect(queue.isGlobalProcessing()).toBe(false);
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: undefined }));
      await waitFor(() => queue.isGlobalProcessing());
      expect(queue.isGlobalProcessing()).toBe(true);
      await waitFor(() => !queue.isGlobalProcessing(), { timeout: 2000 });
      expect(queue.isGlobalProcessing()).toBe(false);
    });

    it("returns max size", () => {
      const queue = new MessageQueue(25);
      expect(queue.getMaxSize()).toBe(25);
    });
  });

  describe("global error paths", () => {
    it("rejects global messages when handler throws", async () => {
      vi.useFakeTimers();
      try {
        const queue = new MessageQueue(10);
        const rejections: string[] = [];

        queue.setHandler(async (msg) => {
          if (msg.text === "fail") {
            throw new Error("global handler error");
          }
          msg.resolve("ok");
        });

        queue.enqueue({
          action: "test",
          id: "1",
          text: "ok",
          chatId: 1,
          sessionName: undefined,
          resolve: () => {},
          reject: (e) => rejections.push((e as Error).message),
        });
        queue.enqueue({
          action: "test",
          id: "2",
          text: "fail",
          chatId: 1,
          sessionName: undefined,
          resolve: () => {},
          reject: (e) => rejections.push((e as Error).message),
        });

        await vi.advanceTimersByTimeAsync(4000);

        expect(rejections).toContain("global handler error");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects global messages when handler is not set", async () => {
      const queue = new MessageQueue(10);
      const rejections: string[] = [];

      queue.enqueue({
        action: "test",
        id: "1",
        text: "a",
        chatId: 1,
        sessionName: undefined,
        resolve: () => {},
        reject: (e) => rejections.push((e as Error).message),
      });

      await waitFor(() => rejections.length > 0);

      expect(rejections).toContain("Queue handler not set");
    });
  });

  describe("queue introspection", () => {
    it("returns session queue contents", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 500));
        msg.resolve("");
      });
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: "s1" }));
      // Wait until msg1 is being processed (dequeued), then enqueue msg2
      await waitFor(() => queue.isSessionProcessing("s1"));
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: "s1" }));
      const sessionQueue = queue.getSessionQueue("s1");
      expect(sessionQueue.length).toBe(1);
      expect(sessionQueue[0]?.text).toBe("b");
      expect(queue.getSessionQueue("nonexistent")).toEqual([]);
    });

    it("returns global queue contents", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 500));
        msg.resolve("");
      });
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: undefined }));
      // Wait until global processing started (msg1 dequeued), then enqueue msg2
      await waitFor(() => queue.isGlobalProcessing());
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: undefined }));
      const globalQueue = queue.getGlobalQueue();
      expect(globalQueue.length).toBe(1);
      expect(globalQueue[0]?.text).toBe("b");
    });

    it("returns session names with queued or processing messages", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 500));
        msg.resolve("");
      });
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: "s1" }));
      queue.enqueue(createTestMessage({ id: "2", text: "b", sessionName: "s2" }));
      await waitFor(() => queue.isSessionProcessing("s1") && queue.isSessionProcessing("s2"));
      const names = queue.getSessionNames();
      expect(names).toContain("s1");
      expect(names).toContain("s2");
    });

    it("clears session and rejects queued messages", async () => {
      const queue = new MessageQueue(10);
      queue.setHandler(async (msg) => {
        await new Promise((r) => setTimeout(r, 500));
        msg.resolve("");
      });
      const rejections: string[] = [];
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: "s1" }));
      // Wait until msg1 is being processed so we can enqueue msg2 into the waiting queue
      await waitFor(() => queue.isSessionProcessing("s1"));
      queue.enqueue({
        action: "test",
        id: "2",
        text: "b",
        chatId: 1,
        sessionName: "s1",
        resolve: () => {},
        reject: (e) => rejections.push((e as Error).message),
      });
      queue.clearSession("s1");
      expect(rejections).toContain("Session removed, message cancelled");
    });
  });

  describe("message dedup", () => {
    const mkTextMsg = (id: string, text: string, chatId: number) => ({
      action: "text" as const,
      id,
      text,
      chatId,
      sessionName: "s1",
      resolve: () => {},
      reject: () => {},
    });
    const mkBlocker = () => ({
      action: "text" as const,
      id: "0",
      text: "blocker",
      chatId: 99,
      sessionName: "s1",
      resolve: () => {},
      reject: () => {},
    });

    it("skips identical text when same content is waiting in the session queue", async () => {
      const queue = new MessageQueue(10);
      let releaseBlocker!: () => void;
      queue.setHandler(async (msg) => {
        if (msg.id === "0")
          await new Promise<void>((r) => {
            releaseBlocker = r;
          });
        msg.resolve("ok");
      });
      queue.enqueue(mkBlocker()); // blocks the session
      await waitFor(() => queue.isSessionProcessing("s1"));

      queue.enqueue(mkTextMsg("1", "hello", 42)); // waiting in queue
      expect(queue.size("s1")).toBe(1);
      queue.enqueue(mkTextMsg("2", "hello", 42)); // duplicate → deduped
      expect(queue.size("s1")).toBe(1);

      releaseBlocker();
    });

    it("reports dedup distinctly: 'queued' vs 'duplicate' (both truthy)", async () => {
      const queue = new MessageQueue(10);
      let releaseBlocker!: () => void;
      queue.setHandler(async (msg) => {
        if (msg.id === "0")
          await new Promise<void>((r) => {
            releaseBlocker = r;
          });
        msg.resolve("ok");
      });
      queue.enqueue(mkBlocker());
      await waitFor(() => queue.isSessionProcessing("s1"));

      // Callers that only truthy-check keep working; callers that must release
      // resources (a deduped message NEVER resolves/rejects) can tell them apart.
      expect(queue.enqueue(mkTextMsg("1", "hello", 42))).toBe("queued");
      expect(queue.enqueue(mkTextMsg("2", "hello", 42))).toBe("duplicate");

      releaseBlocker();
    });

    it("allows different text from the same chatId through", async () => {
      const queue = new MessageQueue(10);
      let releaseBlocker!: () => void;
      queue.setHandler(async (msg) => {
        if (msg.id === "0")
          await new Promise<void>((r) => {
            releaseBlocker = r;
          });
        msg.resolve("ok");
      });
      queue.enqueue(mkBlocker());
      await waitFor(() => queue.isSessionProcessing("s1"));

      queue.enqueue(mkTextMsg("1", "hello", 42));
      queue.enqueue(mkTextMsg("2", "world", 42)); // different text → not deduped
      expect(queue.size("s1")).toBe(2);

      releaseBlocker();
    });

    it("allows non-text actions through even if chatId is the same", async () => {
      const queue = new MessageQueue(10);
      let releaseBlocker!: () => void;
      queue.setHandler(async (msg) => {
        if (msg.id === "0")
          await new Promise<void>((r) => {
            releaseBlocker = r;
          });
        msg.resolve("ok");
      });
      queue.enqueue(mkBlocker());
      await waitFor(() => queue.isSessionProcessing("s1"));

      const s1 = {
        action: "start" as const,
        id: "1",
        text: "x",
        chatId: 42,
        sessionName: "s1",
        resolve: () => {},
        reject: () => {},
      };
      const s2 = { ...s1, id: "2" };
      queue.enqueue(s1);
      queue.enqueue(s2); // non-text: both should be in queue
      expect(queue.size("s1")).toBe(2);

      releaseBlocker();
    });
  });

  describe("maxConcurrentSessions", () => {
    it("defers processing of a new session when the limit is reached", async () => {
      // maxConcurrentSessions = 1 → second session can't start until first finishes
      const queue = new MessageQueue(10, undefined, 1);
      let releaseS1!: () => void;
      let s2Processed = false;
      queue.setHandler(async (msg) => {
        if (msg.sessionName === "s1")
          await new Promise<void>((r) => {
            releaseS1 = r;
          });
        msg.resolve("ok");
      });
      queue.enqueue(createTestMessage({ id: "1", text: "a", sessionName: "s1" }));
      await waitFor(() => queue.isSessionProcessing("s1"));

      // s2 is enqueued; at limit, processSession defers via setTimeout
      queue.enqueue({
        action: "test",
        id: "2",
        text: "b",
        chatId: 2,
        sessionName: "s2",
        resolve: () => {
          s2Processed = true;
        },
        reject: () => {},
      });
      // s2 should not have started yet (deferred)
      expect(queue.isSessionProcessing("s2")).toBe(false);

      // Release s1 — s2's deferred processSession will fire ~1s later
      releaseS1();
      await waitFor(() => s2Processed, { timeout: 3000 });
      expect(s2Processed).toBe(true);
    });
  });
});
