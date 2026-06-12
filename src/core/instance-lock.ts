import * as fs from "node:fs";
import { appStateFile } from "../shared/state-dir.js";

/**
 * Runtime single-instance lock. Two bot processes polling the same Telegram
 * token fight over getUpdates (409 Conflict) — historically caused by
 * `stop.sh` + launchd KeepAlive respawning behind a manual `start.sh`. The
 * docs warn about it; this makes the second process refuse to start instead.
 *
 * Mechanics: a JSON lock file ({pid, startedAt}) in the state dir, created
 * with O_EXCL. If the file exists, the holder pid is liveness-checked with
 * kill(pid, 0): a live holder is a hard conflict, a dead/corrupt one is stale
 * and taken over. No heartbeat needed — pid liveness is the staleness test.
 */

const LOCK_FILE = ".instance.lock";

export interface InstanceLockHolder {
  pid: number;
  startedAt: string;
}

export class InstanceLockHeldError extends Error {
  constructor(readonly holder: InstanceLockHolder) {
    super(`another instance is already running (pid=${holder.pid}, since ${holder.startedAt})`);
    this.name = "InstanceLockHeldError";
  }
}

const lockPath = (): string => appStateFile(LOCK_FILE);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but belongs to another user → alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(): InstanceLockHolder | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(), "utf8")) as Partial<InstanceLockHolder>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return undefined;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined; // missing or corrupt → treated as stale
  }
}

/** Create the lock file atomically; false when it already exists. */
function tryCreate(): boolean {
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;
  try {
    fs.writeFileSync(lockPath(), payload, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Acquire the lock or throw InstanceLockHeldError naming the live holder.
 * Stale locks (dead holder, corrupt file) are removed and retaken.
 */
export function acquireInstanceLock(): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate()) return;
    const holder = readHolder();
    if (holder && holder.pid !== process.pid && isAlive(holder.pid)) {
      throw new InstanceLockHeldError(holder);
    }
    // Compare-and-delete: only remove the file if it STILL holds the exact
    // stale/corrupt holder we just inspected. An unconditional rmSync here races
    // a concurrent starter — between our readHolder and this line it may have
    // taken the lock cleanly, and a blind delete would wipe its fresh, valid lock
    // and let both processes proceed (the 409 this lock exists to prevent).
    if (!removeIfHolder(holder)) return; // someone else won the race → leave their lock be
  }
  throw new Error(`failed to acquire instance lock at ${lockPath()}`);
}

/**
 * Remove the lock only if it still names `expected` (or is already gone/corrupt).
 * Returns false when a *different* holder now owns the file — a concurrent starter
 * won the race, so we leave their lock be. Re-reads immediately before deleting,
 * which narrows but does not fully close the window (POSIX has no compare-and-swap
 * on file content); that residual gap is microseconds with no intervening syscall,
 * versus the previous unconditional delete that raced across the whole liveness check.
 */
function removeIfHolder(expected: InstanceLockHolder | undefined): boolean {
  const current = readHolder();
  if (current && current.pid !== expected?.pid) return false;
  fs.rmSync(lockPath(), { force: true });
  return true;
}

/** Remove the lock only if this process holds it. */
export function releaseInstanceLock(): void {
  const holder = readHolder();
  if (holder?.pid !== process.pid) return;
  try {
    fs.rmSync(lockPath(), { force: true });
  } catch {
    /* best-effort; a stale file is taken over on next start anyway */
  }
}
