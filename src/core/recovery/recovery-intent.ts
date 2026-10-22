import { JsonMapStore } from "../infra/json-map-store.js";

export type RecoveryIntent = {
  taskId: string;
  startedAt: number;
};

const store = new JsonMapStore<RecoveryIntent>("recovery_intents.json");
const STALE_RECOVERY_INTENT_MS = 24 * 60 * 60 * 1000;

function isFresh(intent: RecoveryIntent, now = Date.now()): boolean {
  return now - intent.startedAt <= STALE_RECOVERY_INTENT_MS;
}

/** Record that a bot-dispatched task may need to be resumed after a crash. */
export function markRecoveryIntent(session: string, taskId: string, startedAt = Date.now()): void {
  // A session is serialized by MessageQueue. Keeping the first active marker
  // prevents a later queued item from hiding the task that was interrupted.
  const current = store.get(session);
  if (!current || startedAt - current.startedAt > STALE_RECOVERY_INTENT_MS) {
    store.set(session, { taskId, startedAt });
  }
}

/** Return the task that authorizes automatic recovery, if one exists. */
export function recoveryIntentFor(session: string): RecoveryIntent | null {
  const intent = store.get(session);
  if (!intent || !isFresh(intent)) return null;
  return intent;
}

export function hasRecoveryIntent(session: string): boolean {
  return recoveryIntentFor(session) !== null;
}

/** Clear an intent only when its task id still owns the session marker. */
export function clearRecoveryIntent(session: string, taskId: string): boolean {
  const current = store.get(session);
  if (!current || current.taskId !== taskId) return false;
  return store.delete(session);
}

/** Discard any unfinished-task marker for a session that is being terminally cleaned up. */
export function discardRecoveryIntent(session: string): boolean {
  return store.delete(session);
}
