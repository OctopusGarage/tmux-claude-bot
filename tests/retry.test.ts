import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/shared/utils/retry.js";

describe("withRetry", () => {
  it("returns the result on the first success (no retry)", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once after a transient failure, then succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValue("ok");
    expect(await withRetry(fn, 2, 0)).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("re-throws the last error after every attempt fails", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
