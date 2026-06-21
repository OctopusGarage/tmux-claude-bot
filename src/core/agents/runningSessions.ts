import { JsonMapStore } from "../infra/json-map-store.js";

/**
 * The set of tmux sessions the bot currently believes have a RUNNING agent —
 * maintained at the agent-lifecycle chokepoint (the dispatcher): a session is
 * marked running when an agent is started/restarted/resumed in it, and stopped
 * when the agent is exited or the project removed.
 *
 * This is what reboot recovery restores: the goal is to bring back the agents
 * that were actually running before the machine restarted, NOT every project the
 * bot has ever seen ({@link sessionPathMap} accumulates all of those). After a
 * reboot tmux is empty, so the last persisted membership of this set is the only
 * record of "what was running" — hence it must survive the restart (it does, like
 * the other state under the state dir) and must NOT be self-healed from live
 * liveness on boot (everything looks dead then, which would wipe it before
 * recovery reads it).
 *
 * The value is the epoch-ms the session was last marked running (kept for
 * debugging / future freshness checks); presence is what matters.
 */
const store = new JsonMapStore<number>("running_sessions.json");

/** Mark a session as having a running agent (start / restart / resume). */
export function markSessionRunning(sessionName: string, now = Date.now()): void {
  store.set(sessionName, now);
}

/** Mark a session as no longer running (agent exited, or project removed). */
export function markSessionStopped(sessionName: string): void {
  store.delete(sessionName);
}

/** Whether the bot last knew this session to have a running agent. */
export function isSessionRunning(sessionName: string): boolean {
  return store.has(sessionName);
}

/** Epoch-ms this session was last marked running, or null if not in the roster.
 * Used to tell a session that ran-then-exited THIS boot (drop it) from a
 * pre-reboot entry still pending recovery (keep it). */
export function sessionRunningSince(sessionName: string): number | null {
  return store.get(sessionName) ?? null;
}

/** Every session the bot last knew to be running — the reboot-recovery roster. */
export function allRunningSessions(): string[] {
  return store.sortedEntries().map(([session]) => session);
}
