import { createLogger } from "./logger.js";

const log = createLogger("timing");

/**
 * Time a single network/IO call (typically a Telegram Bot API request through
 * the proxy) and log how long it took. This is what makes per-call latency
 * visible without polluting normal lifecycle logs: successful calls emit
 * structured DEBUG timing; failures emit structured WARN evidence and rethrow.
 */
export async function timeApi<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    log.debug("external call completed", { data: { label, durationMs: Date.now() - t0 } });
    return result;
  } catch (err) {
    log.warn("external call failed", {
      err,
      data: { label, durationMs: Date.now() - t0 },
    });
    throw err;
  }
}
