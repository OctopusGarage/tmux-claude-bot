import * as fs from "node:fs";
import * as nodePath from "node:path";
import { logger } from "../utils/logger.js";

export type RouteName = string;

export interface RouteStats {
  /** Exponentially-weighted moving average of success latency (ms); null until first success. */
  ewmaMs: number | null;
  /** Consecutive failures since the last success. */
  failStreak: number;
  lastOkAt: number;
  lastTriedAt: number;
  samples: number;
}

export type RouteHealth = Record<RouteName, RouteStats>;

const ALPHA = 0.3; // EWMA weight for the newest sample
const BASELINE_MS = 1500; // assumed latency for an untried route
const FAIL_PENALTY_MS = 5000; // added to the score per consecutive failure

export function initialStats(): RouteStats {
  return { ewmaMs: null, failStreak: 0, lastOkAt: 0, lastTriedAt: 0, samples: 0 };
}

export function recordSuccess(s: RouteStats, latencyMs: number, now: number): RouteStats {
  const ewmaMs = s.ewmaMs === null ? latencyMs : ALPHA * latencyMs + (1 - ALPHA) * s.ewmaMs;
  return {
    ewmaMs,
    failStreak: 0,
    lastOkAt: now,
    lastTriedAt: now,
    samples: s.samples + 1,
  };
}

export function recordFailure(s: RouteStats, now: number): RouteStats {
  return { ...s, failStreak: s.failStreak + 1, lastTriedAt: now };
}

/**
 * Record a success that should NOT update the latency average — used for
 * long-poll (getUpdates) calls whose duration is dominated by waiting for an
 * update, not by route speed. It still clears the fail streak so a working
 * route stays preferred.
 */
export function recordAlive(s: RouteStats, now: number): RouteStats {
  return { ...s, failStreak: 0, lastOkAt: now, lastTriedAt: now, samples: s.samples + 1 };
}

/** Lower is better. A route's recent latency plus a penalty for consecutive failures. */
export function routeScore(s: RouteStats): number {
  const base = s.ewmaMs ?? BASELINE_MS;
  return base + s.failStreak * FAIL_PENALTY_MS;
}

export function chooseRoute(
  health: RouteHealth,
  available: RouteName[],
  defaultRoute: RouteName,
): RouteName {
  if (available.length === 0) return defaultRoute;
  let best = available[0] as RouteName;
  let bestScore = routeScore(health[best] ?? initialStats());
  for (const route of available.slice(1)) {
    const score = routeScore(health[route] ?? initialStats());
    // Strictly-better wins; on a tie the earlier route (default listed first) holds.
    if (score < bestScore - 1e-9) {
      best = route;
      bestScore = score;
    }
  }
  // On a cold/total tie, honor the configured default if it is among the best.
  const defaultScore = routeScore(health[defaultRoute] ?? initialStats());
  if (available.includes(defaultRoute) && Math.abs(defaultScore - bestScore) < 1e-9) {
    return defaultRoute;
  }
  return best;
}

export interface RouteHealthStore {
  /** The currently-preferred route. */
  select(): RouteName;
  /** Record a success. Omit `latencyMs` for long-poll calls (keeps EWMA unchanged). */
  recordSuccess(route: RouteName, latencyMs?: number): void;
  recordFailure(route: RouteName): void;
  snapshot(): RouteHealth;
}

function loadHealth(filePath: string, available: RouteName[]): RouteHealth {
  let parsed: RouteHealth = {};
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RouteHealth;
  } catch {
    parsed = {};
  }
  const health: RouteHealth = {};
  for (const route of available) {
    health[route] = parsed[route] ?? initialStats();
  }
  return health;
}

export function createRouteHealthStore(opts: {
  filePath?: string;
  available: RouteName[];
  defaultRoute: RouteName;
  now?: () => number;
}): RouteHealthStore {
  const { filePath, available, defaultRoute } = opts;
  const now = opts.now ?? Date.now;
  const health: RouteHealth = filePath
    ? loadHealth(filePath, available)
    : Object.fromEntries(available.map((r) => [r, initialStats()]));

  const persist = (): void => {
    if (!filePath) return;
    try {
      fs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(health, null, 2), "utf-8");
    } catch (err) {
      logger.warn(
        `[route-health] failed to persist ${filePath}: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  return {
    select: () => chooseRoute(health, available, defaultRoute),
    recordSuccess: (route, latencyMs) => {
      const stats = health[route] ?? initialStats();
      health[route] =
        latencyMs === undefined
          ? recordAlive(stats, now())
          : recordSuccess(stats, latencyMs, now());
      persist();
    },
    recordFailure: (route) => {
      health[route] = recordFailure(health[route] ?? initialStats(), now());
      persist();
    },
    snapshot: () => structuredClone(health),
  };
}
