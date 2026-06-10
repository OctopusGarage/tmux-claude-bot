import { sleep } from "./sleep.js";

/**
 * Run `fn`, retrying up to `attempts` total tries on rejection with `delayMs`
 * between tries. Re-throws the last error if every attempt fails. Used to ride
 * out transient hiccups (a proxy drop on a voice download, a Feishu resource
 * that isn't fetchable for a beat after the message arrives).
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}
