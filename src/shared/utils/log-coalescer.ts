import type { ComponentLogger, LogCtx } from "./logger.js";

/**
 * Preserve the first warning for an issue signature, demote identical repeats
 * during the interval, then emit a periodic warning with the suppressed count.
 * The bounded key set prevents an attacker-controlled signature stream from
 * becoming an unbounded in-memory log registry.
 */
export function createWarningCoalescer(
  sink: Pick<ComponentLogger, "warn" | "debug">,
  opts: { intervalMs: number; maxKeys?: number; now?: () => number },
): (key: string, msg: string, ctx?: LogCtx) => void {
  const intervalMs = Math.max(1, opts.intervalMs);
  const maxKeys = Math.max(1, opts.maxKeys ?? 500);
  const now = opts.now ?? Date.now;
  const issues = new Map<string, { lastWarningAt: number; repeated: number }>();

  return (key, msg, ctx): void => {
    const observedAt = now();
    const previous = issues.get(key);
    if (
      previous === undefined ||
      observedAt < previous.lastWarningAt ||
      observedAt - previous.lastWarningAt >= intervalMs
    ) {
      const repeated = previous?.repeated ?? 0;
      sink.warn(msg, {
        ...ctx,
        ...(repeated > 0
          ? { data: { ...(ctx?.data ?? {}), repeatedSinceLastWarning: repeated } }
          : {}),
      });
      issues.delete(key);
      issues.set(key, { lastWarningAt: observedAt, repeated: 0 });
      while (issues.size > maxKeys) {
        const oldest = issues.keys().next().value;
        if (oldest === undefined) break;
        issues.delete(oldest);
      }
      return;
    }

    previous.repeated += 1;
    sink.debug(msg, {
      ...ctx,
      data: {
        ...(ctx?.data ?? {}),
        coalesced: true,
        repeatedSinceLastWarning: previous.repeated,
      },
    });
  };
}
