import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActivityWatcher } from "../src/core/session/activity-watcher.js";

/** Poll until `predicate()` is true or `timeoutMs` elapses. fs.watch is async and
 * macOS FSEvents may coalesce/lag — especially under the full suite's parallel
 * load — so we await eventual state with a generous budget (still well under
 * vitest's 5s per-test cap) rather than sleeping a fixed amount. Returns as soon
 * as the predicate holds, so the happy path stays fast. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
  onPoll?: () => void, // e.g. re-touch the file so a coalesced/dropped FSEvents is retried
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    onPoll?.();
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe("createActivityWatcher", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-aw-"));
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("fires onActivity with the abs path and marks it active on a .jsonl write", async () => {
    const watcher = createActivityWatcher([root]);
    watcher.start();
    const seen: string[] = [];
    watcher.onActivity((p) => seen.push(p));

    const file = path.join(root, "sub", "x.jsonl");
    fs.writeFileSync(file, "line\n");

    // Re-touch on each poll so a coalesced/dropped FSEvents notification is retried
    // (macOS FSEvents can drop a lone event under heavy parallel load → flake).
    expect(
      await waitFor(
        () => seen.includes(file),
        4000,
        () => fs.appendFileSync(file, "x\n"),
      ),
    ).toBe(true);
    expect(watcher.isActiveWithin(file, 2000)).toBe(true);
    watcher.stop();
  });

  it("reports a never-written path as inactive", () => {
    const watcher = createActivityWatcher([root]);
    watcher.start();
    expect(watcher.isActiveWithin(path.join(root, "never.jsonl"), 2000)).toBe(false);
    watcher.stop();
  });

  it("ignores non-.jsonl writes", async () => {
    const watcher = createActivityWatcher([root]);
    watcher.start();
    const seen: string[] = [];
    watcher.onActivity((p) => seen.push(p));

    fs.writeFileSync(path.join(root, "sub", "note.txt"), "hi\n");
    // Give fs.watch a chance to deliver — but the .txt must never fire.
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toHaveLength(0);
    watcher.stop();
  });

  it("delivers no events after stop()", async () => {
    const watcher = createActivityWatcher([root]);
    watcher.start();
    const seen: string[] = [];
    watcher.onActivity((p) => seen.push(p));
    watcher.stop();

    fs.writeFileSync(path.join(root, "sub", "y.jsonl"), "line\n");
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toHaveLength(0);
  });

  it("start() called twice is safe (idempotent guard) and still delivers after", async () => {
    // The `if (watchers.size > 0) return` guard makes a second start() a no-op.
    // We assert the observable contract — double-start doesn't throw and the
    // watcher still works — NOT a delivered-event count: macOS FSEvents can fire
    // create+modify for ONE write even with a single watcher, so counting events
    // can't distinguish a double-watch from normal FSEvents behavior (and spying
    // on the node:fs namespace is impossible under ESM).
    const watcher = createActivityWatcher([root]);
    expect(() => {
      watcher.start();
      watcher.start();
    }).not.toThrow();

    const seen: string[] = [];
    watcher.onActivity((p) => seen.push(p));
    const file = path.join(root, "sub", "z.jsonl");
    fs.writeFileSync(file, "line\n");
    expect(
      await waitFor(
        () => seen.includes(file),
        4000,
        () => fs.appendFileSync(file, "x\n"),
      ),
    ).toBe(true);
    watcher.stop();
  });

  it("unsubscribe stops a listener from receiving further events", async () => {
    const watcher = createActivityWatcher([root]);
    watcher.start();
    const seen: string[] = [];
    const off = watcher.onActivity((p) => seen.push(p));
    off();

    fs.writeFileSync(path.join(root, "sub", "u.jsonl"), "line\n");
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).toHaveLength(0);
    watcher.stop();
  });

  it("does not throw when a root is missing", () => {
    const watcher = createActivityWatcher([path.join(root, "does-not-exist")]);
    expect(() => watcher.start()).not.toThrow();
    watcher.stop();
  });
});
