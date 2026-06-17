import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Regression for the stale-takeover TOCTOU in acquireInstanceLock.
 *
 * The two reads it performs (acquire's `readHolder`, then the re-check inside
 * `removeIfHolder`) happen synchronously back-to-back, so the only way to drive
 * the race deterministically is to control what the lock file returns on each
 * read. ESM forbids spying on `node:fs` namespace exports, so this dedicated
 * file mocks the three fs calls the module makes with a tiny in-memory model.
 * The real-filesystem behaviours live in instance-lock.test.ts.
 */

const h = vi.hoisted(() => ({
  content: undefined as string | undefined,
  rmCalls: 0,
  reads: 0,
  // Per-read overrides; falls through to `content` once exhausted.
  readSequence: [] as (string | undefined)[],
}));

vi.mock("node:fs", () => ({
  writeFileSync: (_p: string, data: string, opts?: { flag?: string }) => {
    if (opts?.flag === "wx" && h.content !== undefined) {
      const e = new Error("EEXIST") as NodeJS.ErrnoException;
      e.code = "EEXIST";
      throw e;
    }
    h.content = data;
  },
  readFileSync: () => {
    const override = h.reads < h.readSequence.length ? h.readSequence[h.reads] : h.content;
    h.reads += 1;
    if (override === undefined) {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    }
    return override;
  },
  rmSync: () => {
    h.rmCalls += 1;
    h.content = undefined;
  },
}));

import { acquireInstanceLock } from "../src/core/infra/instance-lock.js";

const holder = (pid: number): string => JSON.stringify({ pid, startedAt: "t" });
const DEAD_PID = 2_000_000_000; // far above any real pid → process.kill(...,0) throws ESRCH

afterEach(() => {
  h.content = undefined;
  h.rmCalls = 0;
  h.reads = 0;
  h.readSequence = [];
  vi.restoreAllMocks();
});

describe("acquireInstanceLock — stale-takeover race", () => {
  it("does not delete a lock a concurrent starter took during the window", () => {
    // The file starts as a stale (dead-holder) lock. acquire's first read sees the
    // dead holder; by the re-check inside removeIfHolder a concurrent starter (a
    // live pid — this very test process) owns it. Its valid lock must survive.
    h.content = holder(DEAD_PID);
    h.readSequence = [holder(DEAD_PID), holder(process.pid)];

    expect(() => acquireInstanceLock()).not.toThrow();
    // The decisive assertion: the winner's lock was never removed.
    expect(h.rmCalls).toBe(0);
  });

  it("still removes a genuinely stale lock whose holder is dead", () => {
    // No concurrent winner: both reads see the dead holder, so takeover proceeds.
    h.content = holder(DEAD_PID);
    h.readSequence = [holder(DEAD_PID), holder(DEAD_PID)];

    expect(() => acquireInstanceLock()).not.toThrow();
    expect(h.rmCalls).toBe(1); // old lock removed, then retaken
    expect(JSON.parse(h.content ?? "{}").pid).toBe(process.pid); // we now hold it
  });
});
