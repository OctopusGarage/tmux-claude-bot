import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingQueue } from "../../src/core/pending-queue.js";

const DELAY = 600;

describe("PendingQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a single item after the quiet window", async () => {
    const flushed: Array<[string, string[]]> = [];
    const q = new PendingQueue<string>(DELAY, (scope, batch) => {
      flushed.push([scope, [...batch]]);
    });

    q.push("chat-1", "a");
    expect(flushed).toEqual([]);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(flushed).toEqual([["chat-1", ["a"]]]);
  });

  it("merges items pushed within the quiet window into one batch", async () => {
    const flushed: string[][] = [];
    const q = new PendingQueue<string>(DELAY, (_scope, batch) => {
      flushed.push([...batch]);
    });

    q.push("chat-1", "a");
    await vi.advanceTimersByTimeAsync(DELAY - 100);
    q.push("chat-1", "b"); // re-arms the window
    await vi.advanceTimersByTimeAsync(DELAY - 100);
    q.push("chat-1", "c");
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(flushed).toEqual([["a", "b", "c"]]);
  });

  it("returns the growing batch size from push", () => {
    const q = new PendingQueue<string>(DELAY, () => {});
    expect(q.push("s", "a")).toBe(1);
    expect(q.push("s", "b")).toBe(2);
    expect(q.push("other", "x")).toBe(1);
  });

  it("keeps scopes independent", async () => {
    const flushed: Array<[string, string[]]> = [];
    const q = new PendingQueue<string>(DELAY, (scope, batch) => {
      flushed.push([scope, [...batch]]);
    });

    q.push("chat-1", "a");
    await vi.advanceTimersByTimeAsync(300);
    q.push("chat-2", "x"); // does NOT re-arm chat-1's window
    await vi.advanceTimersByTimeAsync(300);

    expect(flushed).toEqual([["chat-1", ["a"]]]);
    await vi.advanceTimersByTimeAsync(300);
    expect(flushed).toEqual([
      ["chat-1", ["a"]],
      ["chat-2", ["x"]],
    ]);
  });

  it("a push after a flush starts a fresh batch", async () => {
    const flushed: string[][] = [];
    const q = new PendingQueue<string>(DELAY, (_scope, batch) => {
      flushed.push([...batch]);
    });

    q.push("s", "a");
    await vi.advanceTimersByTimeAsync(DELAY);
    q.push("s", "b");
    await vi.advanceTimersByTimeAsync(DELAY);

    expect(flushed).toEqual([["a"], ["b"]]);
  });

  it("block() pauses the quiet window: no flush while blocked", async () => {
    const flushed: string[][] = [];
    const q = new PendingQueue<string>(DELAY, (_scope, batch) => {
      flushed.push([...batch]);
    });

    q.block("s");
    q.push("s", "a");
    q.push("s", "b");
    await vi.advanceTimersByTimeAsync(DELAY * 3);
    expect(flushed).toEqual([]);
  });

  it("block() cancels an already-armed timer", async () => {
    const flushed: string[][] = [];
    const q = new PendingQueue<string>(DELAY, (_scope, batch) => {
      flushed.push([...batch]);
    });

    q.push("s", "a"); // arms the timer
    q.block("s"); // run started before the window elapsed
    await vi.advanceTimersByTimeAsync(DELAY * 3);
    expect(flushed).toEqual([]);
  });

  it("unblock() arms a fresh window and flushes the accumulated batch as one", async () => {
    const flushed: string[][] = [];
    const q = new PendingQueue<string>(DELAY, (_scope, batch) => {
      flushed.push([...batch]);
    });

    q.block("s");
    q.push("s", "a");
    q.push("s", "b");
    q.unblock("s");
    expect(flushed).toEqual([]); // fresh quiet window, not an immediate flush
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("unblock() with nothing accumulated is a no-op", async () => {
    const flushed: string[][] = [];
    const q = new PendingQueue<string>(DELAY, (_scope, batch) => {
      flushed.push([...batch]);
    });

    q.block("s");
    q.unblock("s");
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(flushed).toEqual([]);
  });

  it("block() only affects its own scope", async () => {
    const flushed: Array<[string, string[]]> = [];
    const q = new PendingQueue<string>(DELAY, (scope, batch) => {
      flushed.push([scope, [...batch]]);
    });

    q.block("busy");
    q.push("busy", "a");
    q.push("idle", "x");
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(flushed).toEqual([["idle", ["x"]]]);
  });

  it("an async flush handler rejection is logged, not unhandled", async () => {
    const q = new PendingQueue<string>(DELAY, async () => {
      throw new Error("boom");
    });

    q.push("s", "a");
    await expect(vi.advanceTimersByTimeAsync(DELAY)).resolves.not.toThrow();
  });
});
