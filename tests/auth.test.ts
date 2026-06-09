import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createAuthGuard, isAuthorized } from "../src/bot/auth.js";

describe("isAuthorized", () => {
  it("rejects everyone when the allowlist is empty (fail closed)", () => {
    expect(isAuthorized(123, new Set())).toBe(false);
  });

  it("rejects an undefined user id", () => {
    expect(isAuthorized(undefined, new Set(["123"]))).toBe(false);
  });

  it("accepts a user id present in the allowlist", () => {
    expect(isAuthorized(123, new Set(["123", "456"]))).toBe(true);
  });

  it("rejects a user id absent from a non-empty allowlist", () => {
    expect(isAuthorized(999, new Set(["123"]))).toBe(false);
  });

  it("matches numeric ids against their string form", () => {
    expect(isAuthorized(456, new Set(["456"]))).toBe(true);
  });
});

describe("createAuthGuard middleware", () => {
  it("calls next() for an authorized user", async () => {
    const guard = createAuthGuard(new Set(["123"]));
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = { from: { id: 123 }, chat: { id: 1 } } as never;
    await guard(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does NOT call next() for an unauthorized user", async () => {
    const guard = createAuthGuard(new Set(["123"]));
    const next = vi.fn().mockResolvedValue(undefined);
    const ctx = { from: { id: 999 }, chat: { id: 1 } } as never;
    await guard(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });
});
