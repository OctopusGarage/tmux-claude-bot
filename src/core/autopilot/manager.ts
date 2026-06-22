import { createLogger } from "../../shared/utils/logger.js";
import type { HandlerDeps } from "../deps.js";
import { isGlobalKeepAlive } from "./global-flag.js";
import { AutopilotStore } from "./state-store.js";
import { runSupervisorTick } from "./supervisor.js";
import { defaultState } from "./types.js";

const log = createLogger("autopilot.manager");

/** One sweep: (global keep-alive) enroll/un-enroll, then enumerate live ∪
 * records, self-heal dead records, and tick the rest. */
export async function tickAllEnabled(
  deps: HandlerDeps,
  store: AutopilotStore,
  now: number,
): Promise<void> {
  const global = isGlobalKeepAlive();
  if (!global && store.enabledSessions().length === 0) return;

  let live: string[];
  try {
    live = await deps.bridge.listProjectSessions();
  } catch (err) {
    log.warn("could not list sessions", { err });
    return;
  }
  const liveSet = new Set(live);

  if (global) {
    // Auto-enroll only PRISTINE sessions (never managed: no startedAt), not
    // opted-out, no active goal. A session autopilot later stops/pauses keeps
    // its startedAt, so it is never resurrected → no runaway.
    for (const session of live) {
      const st = store.get(session);
      if (st.enabled || st.optOut || st.goalId !== undefined || st.startedAt !== undefined)
        continue;
      store.set(session, {
        ...defaultState(st.persona),
        enabled: true,
        pureKeepAlive: true,
        viaGlobal: true,
        startedAt: now,
      });
      log.info("global keep-alive: enrolled session", { session });
    }
  } else {
    // Global turned off: un-enroll the sessions global had auto-enrolled.
    for (const session of store.enabledSessions()) {
      const st = store.get(session);
      if (st.viaGlobal) {
        store.set(session, { ...st, enabled: false, viaGlobal: false });
        log.info("global keep-alive off: un-enrolled session", { session });
      }
    }
  }

  for (const session of store.enabledSessions()) {
    if (!liveSet.has(session)) {
      store.clear(session); // desktop killed it — self-heal
      log.info("cleared autopilot for dead session", { session });
      continue;
    }
    await runSupervisorTick(deps, store, session, now);
  }
}

/** Start the autopilot background loop: a coalesced tick on every transcript
 * activity event plus a fallback interval. `AUTOPILOT_TICK_MS=0` disables it.
 * Returns a stop fn. */
export function startAutopilot(deps: HandlerDeps): () => void {
  const intervalMs = deps.config.autopilot.tickMs;
  if (intervalMs <= 0) {
    log.info("autopilot disabled (AUTOPILOT_TICK_MS=0)");
    return () => {};
  }
  const store = new AutopilotStore();
  let running = false;
  const tick = (): void => {
    if (running) return; // coalesce overlapping ticks
    running = true;
    void tickAllEnabled(deps, store, Date.now())
      .catch((err) => log.warn("tick failed", { err }))
      .finally(() => {
        running = false;
      });
  };
  log.info("autopilot enabled", { data: { intervalMs } });
  const unsub = deps.activity.onActivity(() => tick());
  const initial = setTimeout(tick, Math.min(intervalMs, 5_000));
  const timer = setInterval(tick, intervalMs);
  (initial as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return () => {
    unsub();
    clearTimeout(initial);
    clearInterval(timer);
  };
}
