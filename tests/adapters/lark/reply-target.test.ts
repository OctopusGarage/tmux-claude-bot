import { describe, expect, it } from "vitest";
import {
  recordReplyTarget,
  removeReplyTargetSession,
  resolveReplyTarget,
} from "../../../src/adapters/lark/reply-target.js";

// The map is module-global, so each test uses unique ids/sessions to avoid
// cross-test collisions.

describe("lark reply-target", () => {
  it("record then resolve returns the session", () => {
    recordReplyTarget("msg-record-1", "session-a");
    expect(resolveReplyTarget("msg-record-1")).toBe("session-a");
  });

  it("resolve of an unknown id is undefined", () => {
    expect(resolveReplyTarget("msg-unknown-xyz")).toBeUndefined();
  });

  it("removeReplyTargetSession drops only the matching session's entries", () => {
    recordReplyTarget("msg-rm-1", "session-rm");
    recordReplyTarget("msg-rm-2", "session-rm");
    recordReplyTarget("msg-rm-keep", "session-keep");

    removeReplyTargetSession("session-rm");

    expect(resolveReplyTarget("msg-rm-1")).toBeUndefined();
    expect(resolveReplyTarget("msg-rm-2")).toBeUndefined();
    expect(resolveReplyTarget("msg-rm-keep")).toBe("session-keep");
  });

  it("MAX bound evicts the oldest entry (record MAX+1)", () => {
    const MAX = 500;
    const prefix = "msg-bound-";
    // Insert MAX+1 entries; the very first should be evicted once size > MAX.
    for (let i = 0; i < MAX + 1; i++) {
      recordReplyTarget(`${prefix}${i}`, `session-bound-${i}`);
    }
    // The first inserted id is the oldest and should have been dropped.
    expect(resolveReplyTarget(`${prefix}0`)).toBeUndefined();
    // The most recent is still present.
    expect(resolveReplyTarget(`${prefix}${MAX}`)).toBe(`session-bound-${MAX}`);
  });
});
