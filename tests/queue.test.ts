import { describe, expect, it, vi } from "vitest";
import { MessageQueue } from "../src/core/command/queue.js";
import type { QueueObserver } from "../src/core/command/queue-observer.js";

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
    action: string;
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = {},
) => ({
  action: "test",
  id: "1",
  text: "default",
  chatId: 1,
  sessionName: "s1" as string | undefined,
  resolve: () => {},
  reject: () => {},
  ...overrides,
});

describe("MessageQueue", () => {
  it("reports pending and in-flight work through one lifecycle predicate", async () => {
    const queue = new MessageQueue(10);
    let release: (() => void) | undefined;
    queue.setHandler(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(queue.hasPendingOrRunning()).toBe(false);
    queue.enqueue(createTestMessage({ id: "active" }));
    await waitFor(() => release !== undefined);
    expect(queue.hasPendingOrRunning()).toBe(true);
    release?.();
    await waitFor(() => !queue.hasPendingOrRunning());
    expect(queue.hasPendingOrRunning()).toBe(false);
  });

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

    it("notifies the observer around session message processing", async () => {
      const observer: QueueObserver = {
        started: vi.fn(),
        finished: vi.fn(),
      };
      const queue = new MessageQueue(10, undefined, Infinity, observer);

      queue.setHandler(async (msg) => {
        msg.resolve("ok");
      });

      queue.enqueue(createTestMessage({ id: "1", sessionName: "s1" }));

      await waitFor(() => vi.mocked(observer.finished).mock.calls.length === 1);

      expect(observer.started).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ id: "1", sessionName: "s1" }),
      );
      expect(observer.finished).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ id: "1", sessionName: "s1" }),
      );
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

    it("keeps a queued message pending when its start hook cannot acquire a lease", async () => {
      const queue = new MessageQueue(10);
      const handled: string[] = [];
      const rejections: string[] = [];
      let canStart = false;
      queue.setReadinessProbe(async () => true, 5);
      queue.setHandler(async (msg) => {
        handled.push(msg.id);
        msg.resolve("ok");
      });

      queue.enqueue({
        ...createTestMessage({
          id: "lease-blocked",
          reject: (error) => rejections.push(error.message),
        }),
        started: () => canStart,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toEqual([]);
      expect(handled).toEqual([]);
      expect(queue.size("s1")).toBe(1);

      canStart = true;
      await waitFor(() => handled.length === 1);
      expect(rejections).toEqual([]);
      expect(handled).toEqual(["lease-blocked"]);
      expect(queue.size("s1")).toBe(0);
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

    it("idle-gate: holds a message in the queue while the agent is busy, then runs it", async () => {
      const queue = new MessageQueue(10);
      const results: string[] = [];
      queue.setHandler(async (msg) => {
        results.push(msg.text);
        msg.resolve("ok");
      });

      // Probe reports busy until we flip it; recheck fast so the test isn't slow.
      let idle = false;
      queue.setReadinessProbe(async () => idle, 20);

      queue.enqueue(createTestMessage({ id: "1", text: "a", action: "text" }));

      // While busy: the message stays QUEUED, counts in size, and remains unrun.
      await new Promise((r) => setTimeout(r, 60));
      expect(results).toEqual([]);
      expect(queue.size("s1")).toBe(1);
      expect(queue.isSessionProcessing("s1")).toBe(false); // not dequeued/in-flight

      // Agent goes idle → the held message dispatches on the next recheck.
      idle = true;
      await waitFor(() => results.length === 1);
      expect(results).toEqual(["a"]);
      expect(queue.size("s1")).toBe(0);
    });

    it("idle-gate: a streak continuation skips the gate (no re-probe after a task)", async () => {
      const queue = new MessageQueue(10);
      const results: string[] = [];
      queue.setHandler(async (msg) => {
        results.push(msg.text);
        msg.resolve("ok");
      });

      // Probe is only consulted on a FRESH start; count how often it runs.
      let probes = 0;
      const idle = true;
      queue.setReadinessProbe(async () => {
        probes += 1;
        return idle;
      }, 20);

      // Two messages enqueued up front. The first is a fresh start (1 probe); the
      // second is dispatched as a streak continuation right after, so it must NOT
      // re-probe.
      queue.enqueue(createTestMessage({ id: "1", text: "a", action: "text" }));
      queue.enqueue(createTestMessage({ id: "2", text: "b", action: "text" }));

      await waitFor(() => results.length === 2);
      expect(results).toEqual(["a", "b"]);
      expect(probes).toBe(1); // only the fresh start was gated
    });

    it("idle-gate: a non-text action (restart/exit) bypasses the gate even while busy", async () => {
      const queue = new MessageQueue(10);
      const ran: string[] = [];
      queue.setHandler(async (msg) => {
        ran.push(msg.action);
        msg.resolve("ok");
      });
      // Agent reports BUSY — yet an abort verb must still run (it's how the user
      // breaks a stuck/desktop-driven agent), unlike a text prompt which is held.
      queue.setReadinessProbe(async () => false, 20);

      queue.enqueue(createTestMessage({ id: "r", action: "restart" }));

      await waitFor(() => ran.length === 1);
      expect(ran).toEqual(["restart"]);
    });

    it("cancelQueued: removes ONE waiting message by id (rejects it), leaves the rest", async () => {
      const queue = new MessageQueue(10);
      // Keep the session busy so nothing is dequeued and the items stay queued.
      queue.setReadinessProbe(async () => false, 10_000);
      queue.setHandler(async (msg) => msg.resolve("ok"));

      let rejected: Error | undefined;
      queue.enqueue(
        createTestMessage({
          id: "a",
          text: "first",
          action: "text",
          reject: (e) => (rejected = e),
        }),
      );
      queue.enqueue(createTestMessage({ id: "b", text: "second", action: "text" }));
      await waitFor(() => queue.size("s1") === 2);

      expect(queue.cancelQueued("s1", "a")).toBe(true);
      expect(rejected?.message).toBe("Message cancelled");
      expect(queue.size("s1")).toBe(1);
      expect(queue.getSessionQueue("s1").map((m) => m.id)).toEqual(["b"]);

      // Unknown id → false, no change.
      expect(queue.cancelQueued("s1", "nope")).toBe(false);
      expect(queue.size("s1")).toBe(1);
    });

    it("setQueueAck + rewriteByAck: a reply-ack rewrites its item in place (chat-scoped)", async () => {
      const queue = new MessageQueue(10);
      queue.setReadinessProbe(async () => false, 10_000); // keep items queued
      queue.setHandler(async (msg) => msg.resolve("ok"));
      queue.enqueue(createTestMessage({ id: "q1", text: "old", action: "text" }));
      queue.enqueue(createTestMessage({ id: "q2", text: "keep", action: "text" }));
      await waitFor(() => queue.size("s1") === 2);

      queue.setQueueAck("s1", "q1", "ack-42"); // test messages have chatId 1

      // Scoped by chat: a matching ack in a DIFFERENT chat must not rewrite this item.
      expect(queue.rewriteByAck("ack-42", 999, "x")).toEqual({ kind: "not-found" });
      expect(queue.rewriteByAck("missing", 1, "x")).toEqual({ kind: "not-found" }); // unknown ack
      expect(queue.sessionByAck("ack-42", 1)).toBe("s1");
      expect(queue.rewriteByAck("ack-42", 1, "new")).toEqual({ kind: "rewritten", session: "s1" });
      expect(queue.getSessionQueue("s1").map((m) => [m.id, m.text])).toEqual([
        ["q1", "new"], // rewritten in place, position kept
        ["q2", "keep"],
      ]);

      // A rewrite that would duplicate another queued item is blocked, not applied.
      expect(queue.rewriteByAck("ack-42", 1, "keep")).toEqual({ kind: "duplicate", session: "s1" });
      expect(queue.getSessionQueue("s1")[0]?.text).toBe("new"); // unchanged

      // The binding is dropped with the item (cancel removes it → ack no longer resolves).
      queue.cancelQueued("s1", "q1");
      expect(queue.rewriteByAck("ack-42", 1, "z")).toEqual({ kind: "not-found" });
    });

    it("rewriteByAck can update prompt transform metadata with the delivered prompt", async () => {
      const queue = new MessageQueue(10);
      queue.setReadinessProbe(async () => false, 10_000);
      queue.setHandler(async (msg) => msg.resolve("ok"));
      queue.enqueue(createTestMessage({ id: "q1", text: "old", action: "text" }));
      await waitFor(() => queue.size("s1") === 1);
      queue.setQueueAck("s1", "q1", "ack-42");

      expect(
        queue.rewriteByAck("ack-42", 1, "Ship it", {
          origin: "user",
          promptSource: "telegram",
          sourceText: "发出去",
          transform: {
            kind: "translation",
            provider: "argos",
            from: "zh",
            to: "en",
            sourceText: "发出去",
            deliveredText: "Ship it",
          },
        }),
      ).toEqual({ kind: "rewritten", session: "s1" });
      expect(queue.getSessionQueue("s1")[0]).toMatchObject({
        text: "Ship it",
        origin: "user",
        promptSource: "telegram",
        sourceText: "发出去",
        transform: { kind: "translation", deliveredText: "Ship it" },
      });
    });

    it("rewriteByAck: the SAME ack id in two chats rewrites only the addressed chat's item", async () => {
      // A Telegram message_id is unique only within a chat, so two chats can hold a
      // queued ack with the same id — the chat scoping must keep them apart.
      const queue = new MessageQueue(10);
      queue.setReadinessProbe(async () => false, 10_000);
      queue.setHandler(async (msg) => msg.resolve("ok"));
      queue.enqueue(
        createTestMessage({ id: "a", sessionName: "s1", chatId: 1, action: "text", text: "A" }),
      );
      queue.enqueue(
        createTestMessage({ id: "b", sessionName: "s2", chatId: 2, action: "text", text: "B" }),
      );
      await waitFor(() => queue.size("s1") === 1 && queue.size("s2") === 1);
      queue.setQueueAck("s1", "a", "dup-ack");
      queue.setQueueAck("s2", "b", "dup-ack"); // same ack id, different chat

      // Reply in chat 1 hits s1's item only; s2's identical-ack item is untouched.
      expect(queue.rewriteByAck("dup-ack", 1, "A2")).toEqual({ kind: "rewritten", session: "s1" });
      expect(queue.getSessionQueue("s1")[0]?.text).toBe("A2");
      expect(queue.getSessionQueue("s2")[0]?.text).toBe("B");

      // And a reply in chat 2 hits s2's item.
      expect(queue.rewriteByAck("dup-ack", 2, "B2")).toEqual({ kind: "rewritten", session: "s2" });
      expect(queue.getSessionQueue("s2")[0]?.text).toBe("B2");
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
      expect(releaseMsgA).toBeDefined();
      if (releaseMsgA === undefined) throw new Error("releaseMsgA was not initialized");
      releaseMsgA();

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
      expect(releaseMsgA).toBeDefined();
      if (releaseMsgA === undefined) throw new Error("releaseMsgA was not initialized");
      releaseMsgA();

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

    it("skips identical text matching the message currently being processed (in-flight)", async () => {
      const queue = new MessageQueue(10);
      let releaseBlocker!: () => void;
      queue.setHandler(async (msg) => {
        if (msg.id === "0")
          await new Promise<void>((r) => {
            releaseBlocker = r;
          });
        msg.resolve("ok");
      });
      queue.enqueue(mkBlocker()); // text "blocker", chatId 99 — gets dequeued, now in-flight
      await waitFor(() => queue.isSessionProcessing("s1"));
      expect(queue.size("s1")).toBe(0); // no longer waiting — it's being processed

      // Re-sending the identical text WHILE it is still processing must dedup, not
      // enqueue a second copy that would be typed into the pane a second time.
      expect(queue.enqueue(mkTextMsg("dup", "blocker", 99))).toBe("duplicate");
      expect(queue.size("s1")).toBe(0);

      releaseBlocker();
    });

    it("skips identical text matching the in-flight GLOBAL message (not just session)", async () => {
      const queue = new MessageQueue(10);
      let release!: () => void;
      queue.setHandler(async (msg) => {
        if (msg.text === "gblock")
          await new Promise<void>((r) => {
            release = r;
          });
        msg.resolve("ok");
      });
      // A global message (no sessionName) — dequeued into currentGlobalMessage.
      const gmsg = (id: string) => ({
        action: "text" as const,
        id,
        text: "gblock",
        chatId: 7,
        resolve() {},
        reject() {},
      });
      queue.enqueue(gmsg("g0"));
      await waitFor(() => queue.isGlobalProcessing());

      expect(queue.enqueue(gmsg("g1"))).toBe("duplicate");

      release();
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
