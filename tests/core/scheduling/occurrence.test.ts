import { describe, expect, it } from "vitest";
import { nextFire } from "../../../src/core/scheduling/occurrence.js";

describe("nextFire", () => {
  it("returns the first cron minute strictly after the anchor", () => {
    expect(nextFire({ kind: "cron", cron: "5 * * * *" }, Date.UTC(2026, 7, 13, 1, 5))).toBe(
      Date.UTC(2026, 7, 13, 2, 5),
    );
  });

  it("preserves immediate and one-shot schedule semantics", () => {
    expect(nextFire({ kind: "now" }, 10)).toBe(10);
    expect(nextFire({ kind: "at", at: 11 }, 10)).toBe(11);
    expect(nextFire({ kind: "at", at: 10 }, 10)).toBeNull();
  });

  it("rejects malformed cron expressions", () => {
    expect(nextFire({ kind: "cron", cron: "not a cron" }, 0)).toBeNull();
  });
});
