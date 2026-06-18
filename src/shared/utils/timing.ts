import { createLogger } from "./logger.js";

const log = createLogger("timing");

/**
 * Time a single network/IO call (typically a Telegram Bot API request through
 * the proxy) and log how long it took. This is what makes per-call latency
 * visible in the logs: every egress point logs `[api] <label> ok dur_ms=N`, or
 * `FAIL dur_ms=N` on error (then rethrows so existing handling is unchanged).
 */
export async function timeApi<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    log.info(`${label} ok dur_ms=${Date.now() - t0}`);
    return result;
  } catch (err) {
    log.warn(
      `${label} FAIL dur_ms=${Date.now() - t0} err=${err instanceof Error ? err.message : err}`,
    );
    throw err;
  }
}
