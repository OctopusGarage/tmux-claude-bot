import type { Context, NextFunction } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { createAuthGuard, isAuthorized } from "../../../src/adapters/telegram/auth.js";

vi.mock("../../../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

describe("isAuthorized — fails closed", () => {
  it("rejects everyone when the allowlist is empty", () => {
    expect(isAuthorized(123, new Set())).toBe(false);
  });

  it("rejects an undefined user id", () => {
    expect(isAuthorized(undefined, new Set(["123"]))).toBe(false);
  });

  it("accepts a listed user (number id matched against string set)", () => {
    expect(isAuthorized(123, new Set(["123"]))).toBe(true);
  });

  it("rejects an unlisted user", () => {
    expect(isAuthorized(999, new Set(["123"]))).toBe(false);
  });
});

describe("createAuthGuard middleware", () => {
  function ctx(id: number | undefined): Context {
    return { from: id === undefined ? undefined : { id }, chat: { id } } as unknown as Context;
  }

  it("calls next() for an authorized user", async () => {
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    await createAuthGuard(new Set(["123"]))(ctx(123), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("drops (no next) for an unauthorized user", async () => {
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    await createAuthGuard(new Set(["123"]))(ctx(999), next);
    expect(next).not.toHaveBeenCalled();
  });

  it("drops (no next) when the allowlist is empty", async () => {
    const next = vi.fn(async () => {}) as unknown as NextFunction;
    await createAuthGuard(new Set())(ctx(123), next);
    expect(next).not.toHaveBeenCalled();
  });
});
