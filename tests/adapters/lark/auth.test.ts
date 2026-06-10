import { describe, expect, it } from "vitest";
import { isOpenIdAllowed } from "../../../src/adapters/lark/auth.js";

describe("isOpenIdAllowed", () => {
  it("rejects everyone when the allowlist is empty", () => {
    expect(isOpenIdAllowed("ou_a", new Set())).toBe(false);
  });
  it("allows a listed open_id", () => {
    expect(isOpenIdAllowed("ou_a", new Set(["ou_a"]))).toBe(true);
  });
  it("rejects an unlisted open_id", () => {
    expect(isOpenIdAllowed("ou_b", new Set(["ou_a"]))).toBe(false);
  });
  it("rejects an empty open_id", () => {
    expect(isOpenIdAllowed("", new Set(["ou_a"]))).toBe(false);
  });
});
