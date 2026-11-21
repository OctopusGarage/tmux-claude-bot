import { GrammyError } from "grammy";
import { createLogger } from "../../shared/utils/logger.js";

const log = createLogger("telegram.commands");

/** Keep menu synchronization independent of polling and stop with its adapter.
 * The supplied API uses the adapter's existing bounded transport. */
export function startCommandRegistration(register: () => Promise<unknown>): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delayMs = 1_000;
  let failures = 0;
  const attempt = async (): Promise<void> => {
    try {
      await register();
      if (!stopped) log.info("Telegram commands registered", { data: { recovered: failures > 0 } });
    } catch (err) {
      if (stopped) return;
      const permanent =
        err instanceof GrammyError &&
        err.error_code >= 400 &&
        err.error_code < 500 &&
        err.error_code !== 429;
      if (permanent) {
        log.error("Telegram command registration rejected; automatic retry stopped", { err });
        return;
      }
      failures += 1;
      const retryAfterMs =
        err instanceof GrammyError ? (err.parameters.retry_after ?? 0) * 1_000 : 0;
      const retryMs = Math.max(delayMs, retryAfterMs);
      const detail = { err, data: { failures, retryMs } };
      if (failures === 1) log.warn("Telegram command registration failed; retry scheduled", detail);
      else log.debug("Telegram command registration retry failed", detail);
      timer = setTimeout(() => {
        void attempt();
      }, retryMs);
      timer.unref();
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  };
  void attempt();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
