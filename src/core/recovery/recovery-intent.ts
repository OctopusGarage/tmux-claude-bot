import { JsonMapStore } from "../infra/json-map-store.js";

export type RecoveryIntent = {
  taskId: string;
  startedAt: number;
};

const store = new JsonMapStore<RecoveryIntent>("recovery_intents.json");

/** Record that a bot-dispatched task may need to be resumed after a crash. */
export function markRecoveryIntent(session: string, taskId: string, startedAt = Date.now()): void {
  // A session is serialized by MessageQueue. Keeping the first active marker
  // prevents a later queued item from hiding the task that was interrupted.
  if (!store.has(session)) store.set(session, { taskId, startedAt });
}

/** Return the task that authorizes automatic recovery, if one exists. */
export function recoveryIntentFor(session: string): RecoveryIntent | null {
  return store.get(session) ?? null;
}

export function hasRecoveryIntent(session: string): boolean {
  return store.has(session);
}

/** Clear an intent only when its task id still owns the session marker. */
export function clearRecoveryIntent(session: string, taskId: string): boolean {
  const current = store.get(session);
  if (!current || current.taskId !== taskId) return false;
  return store.delete(session);
}
