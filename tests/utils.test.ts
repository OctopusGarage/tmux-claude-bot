import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { stateDir } from "../src/shared/state-dir.js";
import { normalizeError } from "../src/shared/utils/error.js";
import { Queue } from "../src/shared/utils/queue.js";
import { truncate } from "../src/shared/utils/string.js";

function isPathAllowed(targetPath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => {
    const rootPath = root.startsWith("~") ? root.replace("~", process.env.HOME ?? "") : root;
    return targetPath.startsWith(`${rootPath}/`) || targetPath === rootPath;
  });
}

describe("isPathAllowed", () => {
  const allowed = ["/home/user/projects", "/home/user/work"];

  it("allows subdirectory", () => {
    expect(isPathAllowed("/home/user/projects/myapp", allowed)).toBe(true);
  });

  it("allows exact match", () => {
    expect(isPathAllowed("/home/user/projects", allowed)).toBe(true);
  });

  it("rejects parent directory", () => {
    expect(isPathAllowed("/home/user", allowed)).toBe(false);
  });

  it("rejects sibling directory", () => {
    expect(isPathAllowed("/home/user/other", allowed)).toBe(false);
  });

  it("handles ~ in allowed roots", () => {
    const home = process.env.HOME ?? "/home/user";
    const withTilde = ["~/OctopusGarage"];
    expect(isPathAllowed(path.join(home, "OctopusGarage"), withTilde)).toBe(true);
  });
});

describe("Queue", () => {
  it("peeks at first item without removing", () => {
    const queue = new Queue<number>();
    expect(queue.peek()).toBeUndefined();
    expect(queue.dequeue()).toBeUndefined();
    queue.enqueue(1);
    queue.enqueue(2);
    expect(queue.peek()).toBe(1);
    expect(queue.dequeue()).toBe(1);
    expect(queue.peek()).toBe(2);
  });

  it("returns shallow copy via toArray", () => {
    const queue = new Queue<string>();
    queue.enqueue("a");
    queue.enqueue("b");
    const arr = queue.toArray();
    expect(arr).toEqual(["a", "b"]);
  });

  it("returns max size", () => {
    const queue = new Queue<number>(42);
    expect(queue.getMaxSize()).toBe(42);
    const defaultQueue = new Queue<number>();
    expect(defaultQueue.getMaxSize()).toBe(Infinity);
  });

  it("rejects enqueue past maxSize and keeps size accurate", () => {
    const queue = new Queue<number>(2);
    expect(queue.enqueue(1)).toBe(true);
    expect(queue.enqueue(2)).toBe(true);
    expect(queue.enqueue(3)).toBe(false); // full
    expect(queue.size()).toBe(2);
    queue.dequeue();
    expect(queue.enqueue(3)).toBe(true); // room again after dequeue
    expect(queue.toArray()).toEqual([2, 3]);
  });

  it("compacts the backing array after many dequeues without losing items (head>100)", () => {
    const queue = new Queue<number>();
    for (let i = 0; i < 250; i++) queue.enqueue(i);
    // Dequeue past the compaction threshold (head>100 && head*2>=length).
    for (let i = 0; i < 130; i++) expect(queue.dequeue()).toBe(i);
    // Remaining items must still be intact and in order after compaction.
    expect(queue.size()).toBe(120);
    expect(queue.peek()).toBe(130);
    expect(queue.toArray()).toEqual(Array.from({ length: 120 }, (_, i) => i + 130));
  });
});

describe("normalizeError", () => {
  it("returns Error instance as-is", () => {
    const err = new Error("test");
    expect(normalizeError(err)).toBe(err);
  });

  it("wraps string in Error", () => {
    const result = normalizeError("string error");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("string error");
  });

  it("wraps number in Error", () => {
    const result = normalizeError(42);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("42");
  });

  it("wraps object in Error", () => {
    const result = normalizeError({ foo: "bar" });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("[object Object]");
  });

  it("wraps null in Error", () => {
    const result = normalizeError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("null");
  });
});

describe("truncate", () => {
  it("truncates strings longer than maxLen", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });

  it("returns the original string when it is within the limit", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
});

describe("stateDir", () => {
  it("returns TCB_STATE_DIR when set (test isolation override)", () => {
    const result = stateDir("/fallback");
    expect(result).toBe(process.env.TCB_STATE_DIR);
  });

  it("falls back to the provided path when TCB_STATE_DIR is not set", () => {
    const saved = process.env.TCB_STATE_DIR;
    delete process.env.TCB_STATE_DIR;
    try {
      expect(stateDir("/my/fallback")).toBe("/my/fallback");
    } finally {
      process.env.TCB_STATE_DIR = saved;
    }
  });
});
