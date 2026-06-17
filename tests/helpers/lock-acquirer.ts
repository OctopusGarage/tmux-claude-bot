/**
 * Standalone process used by instance-lock-multiprocess.test.ts: try to acquire
 * the real instance lock against $TCB_STATE_DIR, print the outcome, and (when
 * asked) hold it for $HOLD_MS so a sibling process can observe the conflict.
 * Run via tsx. Prints exactly one of ACQUIRED / HELD; exit 1 on anything else.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { acquireInstanceLock, InstanceLockHeldError } from "../../src/core/infra/instance-lock.js";

try {
  acquireInstanceLock();
  console.log("ACQUIRED");
  const holdMs = Number(process.env.HOLD_MS ?? 0);
  if (holdMs > 0) await sleep(holdMs);
  process.exit(0);
} catch (err) {
  if (err instanceof InstanceLockHeldError) {
    console.log("HELD");
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
}
