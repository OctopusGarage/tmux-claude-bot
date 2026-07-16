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
});
