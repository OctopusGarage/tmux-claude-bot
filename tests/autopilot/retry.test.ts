import { describe, expect, it } from "vitest";
import { nextDelayMs } from "../../src/core/autopilot/retry.js";

const policy = {
  maxRetries: 5,
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 8000,
  jitter: false,
};

describe("nextDelayMs", () => {
  it("grows exponentially and clamps to maxDelayMs", () => {
    expect(nextDelayMs(policy, 0)).toBe(1000);
    expect(nextDelayMs(policy, 1)).toBe(2000);
    expect(nextDelayMs(policy, 2)).toBe(4000);
    expect(nextDelayMs(policy, 3)).toBe(8000);
    expect(nextDelayMs(policy, 10)).toBe(8000); // clamped
  });

  it("rounds the non-jitter path so a non-integer backoffFactor yields an integer", () => {
    // 1000 * 1.1^4 = 1464.1 → rounded to a whole millisecond
    const fractional = { ...policy, backoffFactor: 1.1, maxDelayMs: 100000 };
    const d = nextDelayMs(fractional, 4);
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBe(1464);
  });

  it("applies bounded full jitter when enabled", () => {
    const jittered = { ...policy, jitter: true };
    // rng=0 → no jitter added; rng=1 → +100% of base step (still clamped)
    expect(nextDelayMs(jittered, 1, () => 0)).toBe(2000);
    expect(nextDelayMs(jittered, 1, () => 0.5)).toBe(3000);
  });
});
