import { normalizeError } from "../../shared/utils/error.js";
import { logger } from "../../shared/utils/logger.js";

/**
 * App-level keepalive loop for the Lark WebSocket. Defense-in-depth against
 * silent stalls the SDK's internal ping watchdog can miss (laptop sleep/wake,
 * network flaps that leave the WS half-open).
 *
 *  1. 15s timer — independent of the SDK's server-pushed ping cadence.
 *  2. Sleep detection — a tick gap > SLEEP_DETECT_MS means the machine likely
 *     just woke; reset counters and skip this tick (pre-sleep state is stale).
 *  3. Timer-storm guard — on wake, queued intervals can fire back-to-back;
 *     skip ticks closer than TIMER_STORM_GUARD_MS.
 *  4. HTTP probe — before force-reconnecting, check the Lark domain over
 *     HTTP. If even HTTP fails it's a network outage, not a WS issue, and
 *     reconnecting won't help (and would spam logs).
 *  5. Counter debounce — only force-reconnect after DEAD_THRESHOLD
 *     consecutive ticks confirm the WS is down.
 */

const KEEPALIVE_INTERVAL_MS = 15_000;
const SLEEP_DETECT_MS = 30_000;
const TIMER_STORM_GUARD_MS = 5_000;
const HTTP_PROBE_TIMEOUT_MS = 5_000;
const DEAD_THRESHOLD = 3;
const NETWORK_DOWN_LOG_EVERY = 20; // ~every 5min while the network is down

export interface KeepaliveDeps {
  /** Snapshot of the WS state; undefined before the channel first connects. */
  getStatus: () => { state: string; reconnectAttempts: number } | undefined;
  /** HTTP probe target, e.g. https://open.feishu.cn or https://open.larksuite.com. */
  probeUrl: string;
  forceReconnect: () => Promise<void>;
  /** Injectable for tests; defaults to a HEAD fetch against probeUrl. */
  probe?: ((url: string) => Promise<boolean>) | undefined;
  intervalMs?: number | undefined;
}

export interface KeepaliveHandle {
  stop(): void;
}

export function startKeepalive(deps: KeepaliveDeps): KeepaliveHandle {
  const probe = deps.probe ?? httpProbe;
  const intervalMs = deps.intervalMs ?? KEEPALIVE_INTERVAL_MS;

  let lastTick = 0;
  let consecutiveDown = 0;
  let networkDownTicks = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const now = Date.now();
    const sinceLast = lastTick > 0 ? now - lastTick : 0;

    // (3) Timer storm — multiple queued intervals firing at once on wake-up.
    if (sinceLast > 0 && sinceLast < TIMER_STORM_GUARD_MS) {
      return;
    }
    // (2) Sleep detection — machine likely just woke from sleep.
    if (sinceLast > SLEEP_DETECT_MS) {
      logger.info(`[lark-keepalive] wake-up detected (slept ~${Math.round(sinceLast / 1000)}s)`);
      consecutiveDown = 0;
      networkDownTicks = 0;
      lastTick = now;
      return;
    }
    lastTick = now;

    const status = deps.getStatus();
    if (!status) {
      // Channel not initialized yet (pre-connect). Skip.
      return;
    }
    if (status.state === "connected") {
      if (consecutiveDown > 0) {
        logger.info(`[lark-keepalive] recovered after ${consecutiveDown} down tick(s)`);
      }
      consecutiveDown = 0;
      networkDownTicks = 0;
      return;
    }

    // (4) Can the network even reach Lark? If not, it's not a WS-level
    //     problem and force-reconnect won't help.
    const reachable = await probe(deps.probeUrl);
    if (!reachable) {
      networkDownTicks++;
      if (networkDownTicks === 1 || networkDownTicks % NETWORK_DOWN_LOG_EVERY === 0) {
        logger.warn(`[lark-keepalive] network unreachable (${networkDownTicks} tick(s))`);
      }
      consecutiveDown = 0;
      return;
    }
    if (networkDownTicks > 0) {
      logger.info(`[lark-keepalive] network reachable again after ${networkDownTicks} tick(s)`);
      networkDownTicks = 0;
    }

    // Network reachable but WS not connected → WS is stuck.
    consecutiveDown++;
    logger.warn(
      `[lark-keepalive] ws stuck (state=${status.state}, attempts=${status.reconnectAttempts}, down=${consecutiveDown}/${DEAD_THRESHOLD})`,
    );

    // (5) Counter debounce — wait for DEAD_THRESHOLD ticks before reconnecting.
    if (consecutiveDown >= DEAD_THRESHOLD) {
      logger.warn(`[lark-keepalive] force-reconnect (state=${status.state})`);
      consecutiveDown = 0;
      try {
        await deps.forceReconnect();
      } catch (err) {
        logger.error(`[lark-keepalive] force-reconnect failed: ${normalizeError(err).message}`);
      }
    }
  };

  // (1) Independent timer, untied from the SDK's internal ping cadence.
  const timer = setInterval(() => {
    void tick().catch((err) =>
      logger.error(`[lark-keepalive] tick failed: ${normalizeError(err).message}`),
    );
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function httpProbe(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_PROBE_TIMEOUT_MS);
    try {
      // HEAD on root is cheap; any HTTP response (even 4xx/5xx) means the
      // host answered → reachable.
      const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
      return res.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
