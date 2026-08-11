import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { appStateFile } from "../../shared/state-dir.js";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { parseEnv, serializeEnv } from "./onboarding.js";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Map<string, { owner: LockOwner; depth: number }>();

type LockOwner = { token: string; pid: number; createdAt: number };

function environmentPath(): string {
  return appStateFile(".env");
}

function lockPath(environment: string): string {
  return `${environment}.lock`;
}

function ownerPath(lock: string): string {
  return nodePath.join(lock, "owner.json");
}

function readText(path = environmentPath()): string {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function readOwner(lock: string): Partial<LockOwner> | null {
  try {
    return JSON.parse(fs.readFileSync(ownerPath(lock), "utf8")) as Partial<LockOwner>;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function moveStaleLock(lock: string, now: number): boolean {
  let modifiedAt: number;
  try {
    modifiedAt = fs.statSync(lock).mtimeMs;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const owner = readOwner(lock);
  if (typeof owner?.pid === "number" && Number.isInteger(owner.pid) && processIsAlive(owner.pid)) {
    return false;
  }
  if (owner === null && now - modifiedAt < LOCK_STALE_MS) return false;

  const moved = `${lock}.stale-${randomUUID()}`;
  try {
    fs.renameSync(lock, moved);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return true;
    return false;
  }
  fs.rmSync(moved, { recursive: true, force: true });
  return true;
}

function acquireLock(lock: string): LockOwner {
  fs.mkdirSync(nodePath.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    const owner: LockOwner = { token: randomUUID(), pid: process.pid, createdAt: Date.now() };
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try {
        fs.writeFileSync(ownerPath(lock), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      } catch (error) {
        fs.rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      return owner;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (moveStaleLock(lock, Date.now())) continue;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for config environment lock at ${lock}`);
      }
      Atomics.wait(waitBuffer, 0, 0, LOCK_RETRY_MS);
    }
  }
}

function releaseLock(lock: string, owner: LockOwner): void {
  try {
    const current = JSON.parse(fs.readFileSync(ownerPath(lock), "utf8")) as Partial<LockOwner>;
    if (current.token !== owner.token) return;
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    // A failed cleanup must not turn a durable config write into a reported
    // failure. The bounded stale-lock path will recover an abandoned directory.
  }
}

export function withConfigEnvironmentLock<T>(write: (environment: string) => T): T {
  const environment = environmentPath();
  const lock = lockPath(environment);
  const held = heldLocks.get(lock);
  if (held !== undefined) {
    held.depth += 1;
    try {
      return write(environment);
    } finally {
      held.depth -= 1;
    }
  }

  const owner = acquireLock(lock);
  heldLocks.set(lock, { owner, depth: 1 });
  try {
    return write(environment);
  } finally {
    heldLocks.delete(lock);
    releaseLock(lock, owner);
  }
}

/** Read the current personal environment. Atomic replacement keeps this read coherent. */
export function readConfigEnvironment(): Map<string, string> {
  return parseEnv(readText());
}

/** Merge allowlisted/dedicated updates under one cross-process write lock. */
export function writeConfigEnvironment(
  values: Record<string, string>,
  fallbackTemplate = "",
): void {
  withConfigEnvironmentLock((environment) => {
    const current = readText(environment);
    writeFileAtomicSync(
      environment,
      serializeEnv(current === "" ? fallbackTemplate : current, values),
      { mode: 0o600 },
    );
  });
}

/** Persist a live preference only when an environment file already exists. */
export function persistConfigEnvironmentValue(key: string, value: string): void {
  if (!fs.existsSync(environmentPath())) return;
  withConfigEnvironmentLock((environment) => {
    if (!fs.existsSync(environment)) return;
    writeFileAtomicSync(environment, serializeEnv(readText(environment), { [key]: value }), {
      mode: 0o600,
    });
  });
}
