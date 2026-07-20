import { createLogger } from "../../../shared/utils/logger.js";
import type { RouteHealthStore, RouteName } from "./route-health.js";

const log = createLogger("telegram.smart-fetch");

// Kept intentionally loose: the underlying route fetches are node-fetch, whose
// Response type differs from the DOM lib's. We pass responses through untouched
// and cast to grammy's expected `fetch` type at the wiring boundary.
export type RouteFetch = (url: string, init?: Record<string, unknown>) => Promise<unknown>;

export interface SmartFetchRoute {
  name: RouteName;
  fetch: RouteFetch;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A fetch that races two transports (e.g. proxy vs. direct) for resilience.
 * It tries the learned-preferred route first; if that route errors or exceeds
 * `timeoutMs`, it fails over to the other route. Every attempt's outcome and
 * latency is fed back into the health store, so the faster/healthier route is
 * preferred next time and a route that starts failing is abandoned.
 *
 * Long-poll calls (getUpdates) are exempt from the timeout — they legitimately
 * hold the connection open — but if a route errors, the same poll immediately
 * tries the next route. Success/failure still informs the preference, so a dead
 * route gets dropped across poll cycles.
 */
export function createSmartFetch(opts: {
  routes: SmartFetchRoute[];
  health: RouteHealthStore;
  timeoutMs: number;
  isLongPoll: (url: string) => boolean;
  now?: () => number;
}): RouteFetch {
  const now = opts.now ?? Date.now;

  const order = (): SmartFetchRoute[] => {
    const preferred = opts.health.select();
    const first = opts.routes.filter((r) => r.name === preferred);
    const rest = opts.routes.filter((r) => r.name !== preferred);
    return [...first, ...rest];
  };

  const callWithTimeout = (route: SmartFetchRoute, url: string, init?: Record<string, unknown>) => {
    const controller = new AbortController();
    const incoming = init?.signal as AbortSignal | undefined;
    if (incoming?.aborted) controller.abort();
    else incoming?.addEventListener("abort", () => controller.abort(), { once: true });

    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    const fetchPromise = route.fetch(url, { ...init, signal: controller.signal });
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(`route timeout after ${opts.timeoutMs}ms`)),
        { once: true },
      );
    });
    return Promise.race([fetchPromise, timeoutPromise]).finally(() => clearTimeout(timer));
  };

  return async (url, init) => {
    const routes = order();
    if (routes.length === 0) throw new Error("[smart-fetch] no routes configured");

    // Long poll: no local timeout, but fail over on transport errors.
    if (opts.isLongPoll(url)) {
      let lastErr: unknown;
      for (let i = 0; i < routes.length; i++) {
        const route = routes[i] as SmartFetchRoute;
        try {
          const res = await route.fetch(url, init);
          // No latency arg: a long poll's duration is wait-time, not route speed.
          opts.health.recordSuccess(route.name);
          if (i > 0) {
            log.info(`longpoll recovered via ${route.name} after preferred route failed`);
          }
          return res;
        } catch (err) {
          lastErr = err;
          opts.health.recordFailure(route.name);
          const more = i + 1 < routes.length;
          log.warn(
            `longpoll via ${route.name} failed: ${describe(err)}${more ? " — trying other route" : ""}`,
          );
        }
      }
      throw lastErr;
    }

    let lastErr: unknown;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i] as SmartFetchRoute;
      const t0 = now();
      try {
        const res = await callWithTimeout(route, url, init);
        opts.health.recordSuccess(route.name, now() - t0);
        if (i > 0) {
          log.info(`recovered via ${route.name} after preferred route failed`);
        }
        return res;
      } catch (err) {
        lastErr = err;
        opts.health.recordFailure(route.name);
        const more = i + 1 < routes.length;
        log.warn(
          `${route.name} failed in ${now() - t0}ms: ${describe(err)}${more ? " — trying other route" : ""}`,
        );
      }
    }
    throw lastErr;
  };
}
