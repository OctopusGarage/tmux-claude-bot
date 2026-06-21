import { describe, expect, it } from "vitest";
import { isAllowListed } from "../../src/core/infra/allow-list.js";

describe("isAllowListed — the shared fail-CLOSED rule", () => {
  it("rejects everyone when the allowlist is empty (unconfigured = closed)", () => {
    expect(isAllowListed("ou_a", new Set())).toBe(false);
    expect(isAllowListed("123", new Set())).toBe(false);
  });

  it("rejects a missing/empty id even with a non-empty allowlist", () => {
    expect(isAllowListed(undefined, new Set(["123"]))).toBe(false);
    expect(isAllowListed("", new Set(["ou_a"]))).toBe(false);
  });

  it("admits an id present in the allowlist, rejects one absent", () => {
    expect(isAllowListed("123", new Set(["123", "456"]))).toBe(true);
    expect(isAllowListed("999", new Set(["123"]))).toBe(false);
  });
});
