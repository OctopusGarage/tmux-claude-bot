import type { RetryPolicy } from "../../shared/types.js";

/** Exponential backoff for the (0-based) `attempt`th retry, clamped to
 * `maxDelayMs`. With jitter, adds `rng()` × the base step on top of the clamped
 * delay (bounded "equal jitter"), then re-clamps. `rng` is injectable so tests
 * stay deterministic — Math.random is unavailable in some sandboxes anyway. */
export function nextDelayMs(
  policy: RetryPolicy,
  attempt: number,
  rng: () => number = Math.random,
): number {
  const raw = policy.baseDelayMs * policy.backoffFactor ** Math.max(0, attempt);
  const base = Math.min(raw, policy.maxDelayMs);
  if (!policy.jitter) return Math.round(base);
  const jittered = base + rng() * policy.baseDelayMs * policy.backoffFactor ** Math.max(0, attempt);
  return Math.round(Math.min(jittered, policy.maxDelayMs));
}
