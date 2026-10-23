import { describe, expect, it } from "vitest";
import { parseScheduleTime } from "../../src/core/scheduled-messages/time.js";

describe("schedule time", () => {
  it("freezes positive durations", () => {
    expect(parseScheduleTime("30m", 1000).dueAt).toBe(1801000);
  });
  it.each([
    "0m",
    "-1h",
    "2026-02-30T09:00+08:00",
    "2026-10-24T09:00",
    "2020-01-01T00:00Z",
    "25:00",
  ])("rejects %s", (when) => {
    expect(() => parseScheduleTime(when)).toThrow();
  });
  it("accepts explicit offsets", () => {
    expect(parseScheduleTime("2030-01-01T09:00+08:00", 0).dueAt).toBe(
      Date.parse("2030-01-01T01:00Z"),
    );
  });
});
