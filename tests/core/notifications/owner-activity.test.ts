import { describe, expect, it } from "vitest";
import { OwnerActivityTracker } from "../../../src/core/notifications/owner-activity.js";

describe("OwnerActivityTracker", () => {
  it("returns the most recently recorded owner channel", () => {
    const tracker = new OwnerActivityTracker();

    expect(tracker.recent()).toBeUndefined();

    tracker.record("telegram");
    tracker.record("lark");

    expect(tracker.recent()).toBe("lark");
  });

  it("records when accepted owner input was last observed", () => {
    let now = 1_000;
    const tracker = new OwnerActivityTracker(() => now);

    expect(tracker.lastObservedAt()).toBeNull();
    tracker.record("telegram");
    expect(tracker.lastObservedAt()).toBe(1_000);
    now = 2_000;
    tracker.record("lark");
    expect(tracker.lastObservedAt()).toBe(2_000);
  });
});
