import { JsonMapStore } from "../infra/json-map-store.js";

/**
 * Per-session task timing for the dashboard. "Busy" = the bot is driving a task
 * for this session (bracketed by the queue's runHandler). Cumulative busy time
 * is persisted (survives restart); the in-flight start is in-memory. Keyed by
 * tmux session name (path-derived, survives recreation); cleared on removal.
 * Clock is injectable for tests.
 */
const cumulative = new JsonMapStore<number>("session_task_time.json");
const busySince = new Map<string, number>();

export function taskStarted(session: string, now = Date.now()): void {
  busySince.set(session, now);
}

export function taskEnded(session: string, now = Date.now()): void {
  const start = busySince.get(session);
  if (start === undefined) return;
  busySince.delete(session);
  const delta = Math.max(0, now - start);
  cumulative.set(session, (cumulative.get(session) ?? 0) + delta);
}

export function currentTask(
  session: string,
  now = Date.now(),
): { busy: boolean; sinceMs?: number } {
  const start = busySince.get(session);
  return start === undefined ? { busy: false } : { busy: true, sinceMs: Math.max(0, now - start) };
}

export function cumulativeBusyMs(session: string, now = Date.now()): number {
  const persisted = cumulative.get(session) ?? 0;
  const start = busySince.get(session);
  return start === undefined ? persisted : persisted + Math.max(0, now - start);
}

export function clearTaskTiming(session: string): void {
  busySince.delete(session);
  cumulative.delete(session);
}
