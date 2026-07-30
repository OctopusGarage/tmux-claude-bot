import { createLogger } from "../../shared/utils/logger.js";
import {
  markSessionRunning,
  markSessionStopped,
  markSessionUsed,
  sessionLastUsedAt,
  sessionRunningSince,
} from "../agents/runningSessions.js";
import type { HandlerDeps } from "../deps.js";
import { listUserProjectSessions } from "../projects/operator.js";

const log = createLogger("recovery.sweep");

/**
 * One pass of the running-sessions sweep: reconcile the persisted roster against
 * what's actually live in tmux RIGHT NOW, so reboot recovery captures sessions
 * the user started directly in tmux (bypassing the bot) and forgets ones whose
 * agent was exited there.
 *
 * It only ever walks the sessions tmux currently reports — a session that is GONE
 * (right after a reboot) is never touched, so the pre-reboot roster survives. For
 * each live session:
 *   agent running → mark running (catches desktop-started agents)
 *   bare shell that we CONFIRMED running since `bootAt` → mark stopped (it ran and
 *     was exited this session — self-heal)
 *   bare shell whose last-running is from BEFORE `bootAt` → leave it: that's a
 *     pre-reboot session `init()` recreated as a bare shell, still pending
 *     /recover. Dropping it would lose recovery if the user is slow to run it.
 */
export async function runRunningSweep(deps: HandlerDeps, bootAt: number): Promise<void> {
  let sessions: string[];
  try {
    sessions = await listUserProjectSessions(deps);
  } catch (err) {
    log.warn("sweep: could not list sessions", { err });
    return;
  }
  for (const session of sessions) {
    try {
      if (await deps.agent.checkIfRunning(session)) {
        markSessionRunning(session);
        if (sessionLastUsedAt(session) === null) markSessionUsed(session);
      } else {
        const since = sessionRunningSince(session);
        if (since !== null && since >= bootAt) markSessionStopped(session);
      }
    } catch (err) {
      log.warn("sweep: check failed", { session, err });
    }
  }
}

/**
 * Run {@link runRunningSweep} every `intervalMs` (best-effort; never throws into
 * the caller). Returns a stop function. `intervalMs <= 0` disables the sweep.
 */
export function startRunningSweep(deps: HandlerDeps, intervalMs: number): () => void {
  if (intervalMs <= 0) {
    log.info("running-session sweep disabled");
    return () => {};
  }
  log.info("running-session sweep enabled", { data: { intervalMs } });
  // Sessions whose last-running predates this is a pre-reboot entry pending
  // recovery; the sweep must not drop those (see runRunningSweep).
  const bootAt = Date.now();
  const sweep = (): void => {
    void runRunningSweep(deps, bootAt).catch((err) => log.warn("sweep failed", { err }));
  };
  // An early first pass (not the full interval) so the roster reflects reality
  // fast after a deploy/restart where tmux survived; then on the interval.
  const initial = setTimeout(sweep, Math.min(intervalMs, 15_000));
  const timer = setInterval(sweep, intervalMs);
  // Don't keep the process alive for the sweep alone.
  (initial as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
