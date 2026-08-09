import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { uptime } from "node:os";
import * as path from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import type { ResourceGuardianStore } from "./store.js";
import type { ResourceGuardianOperatorState } from "./types.js";

const UNKNOWN_LOCK_STALE_MS = 30_000;

export type ResourceGuardianOperatorConfigKey =
  | "RESOURCE_GUARDIAN_MODE"
  | "RESOURCE_GUARDIAN_PROFILE";

type PendingResourceGuardianOperatorUpdate = {
  schemaVersion: 1;
  key: ResourceGuardianOperatorConfigKey;
  value: string;
  operator: ResourceGuardianOperatorState;
  createdAt: number;
};

type OperatorUpdateLockOwner = {
  schemaVersion: 2;
  token: string;
  pid: number;
  processStartedAt: string;
  createdAt: number;
};

type OperatorUpdateLockSnapshot = {
  owner: OperatorUpdateLockOwner | null;
  dev: number;
  ino: number;
  mtimeMs: number;
};

class OperatorUpdateBusyError extends Error {}

function pendingPath(store: ResourceGuardianStore): string {
  return `${store.paths.operator}.pending`;
}

function lockPath(store: ResourceGuardianStore): string {
  return `${store.paths.operator}.lock`;
}

function isPendingUpdate(value: unknown): value is PendingResourceGuardianOperatorUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const operator = candidate.operator as Record<string, unknown> | undefined;
  return (
    candidate.schemaVersion === 1 &&
    (candidate.key === "RESOURCE_GUARDIAN_MODE" || candidate.key === "RESOURCE_GUARDIAN_PROFILE") &&
    typeof candidate.value === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    operator !== undefined &&
    operator.schemaVersion === 1 &&
    (operator.mode === "observe" || operator.mode === "protect") &&
    (operator.profile === "balanced" || operator.profile === "conservative") &&
    typeof operator.updatedAt === "number" &&
    Number.isFinite(operator.updatedAt) &&
    ((candidate.key === "RESOURCE_GUARDIAN_MODE" && candidate.value === operator.mode) ||
      (candidate.key === "RESOURCE_GUARDIAN_PROFILE" && candidate.value === operator.profile))
  );
}

function isLockOwner(value: unknown): value is OperatorUpdateLockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 2 &&
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.pid === "number" &&
    Number.isInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.processStartedAt === "string" &&
    candidate.processStartedAt.length > 0 &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt)
  );
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readLockOwnerAt(directory: string): OperatorUpdateLockOwner | null {
  const value = readJson(path.join(directory, "owner.json"));
  return isLockOwner(value) ? value : null;
}

function readLockSnapshotAt(directory: string): OperatorUpdateLockSnapshot | null {
  try {
    const stat = fs.lstatSync(directory);
    return {
      owner: readLockOwnerAt(directory),
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function readLockSnapshot(store: ResourceGuardianStore): OperatorUpdateLockSnapshot | null {
  return readLockSnapshotAt(lockPath(store));
}

function readLockOwner(store: ResourceGuardianStore): OperatorUpdateLockOwner | null {
  return readLockOwnerAt(lockPath(store));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function queryProcessStartedAt(pid: number): string | null {
  try {
    const startedAt = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      timeout: 5_000,
    }).trim();
    return startedAt.length > 0 ? startedAt : null;
  } catch {
    return null;
  }
}

let currentProcessStartedAt: string | undefined;

function readProcessStartedAt(pid: number): string | null {
  if (pid !== process.pid) return queryProcessStartedAt(pid);
  if (currentProcessStartedAt === undefined) {
    const startedAt = queryProcessStartedAt(pid);
    if (startedAt !== null) currentProcessStartedAt = startedAt;
    return startedAt;
  }
  return currentProcessStartedAt;
}

function moveMatchingStaleLock(
  store: ResourceGuardianStore,
  expected: OperatorUpdateLockSnapshot,
): boolean {
  const movedPath = `${lockPath(store)}.stale.${randomUUID()}`;
  try {
    fs.renameSync(lockPath(store), movedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const moved = readLockSnapshotAt(movedPath);
  if (
    moved !== null &&
    moved.dev === expected.dev &&
    moved.ino === expected.ino &&
    moved.owner?.token === expected.owner?.token
  ) {
    fs.rmSync(movedPath, { recursive: true, force: true });
    return true;
  }
  try {
    fs.renameSync(movedPath, lockPath(store));
  } catch {
    // Never delete an unrecognized generation; its owner must fail its token check.
  }
  return false;
}

function assertLockOwner(store: ResourceGuardianStore, owner: OperatorUpdateLockOwner): void {
  if (readLockOwner(store)?.token !== owner.token) {
    throw new OperatorUpdateBusyError("Resource Guardian operator update lock changed owner");
  }
}

function acquireLock(input: {
  store: ResourceGuardianStore;
  now: number;
  isProcessAlive: (pid: number) => boolean;
  processStartedAt: (pid: number) => string | null;
}): OperatorUpdateLockOwner {
  fs.mkdirSync(path.dirname(lockPath(input.store)), { recursive: true, mode: 0o700 });
  const processStartedAt = input.processStartedAt(process.pid);
  if (processStartedAt === null) {
    throw new Error("Cannot determine Resource Guardian operator process identity");
  }
  const owner: OperatorUpdateLockOwner = {
    schemaVersion: 2,
    token: randomUUID(),
    pid: process.pid,
    processStartedAt,
    createdAt: input.now,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockPath(input.store), { recursive: false, mode: 0o700 });
      try {
        writeFileAtomicSync(
          path.join(lockPath(input.store), "owner.json"),
          `${JSON.stringify(owner, null, 2)}\n`,
          { mode: 0o600 },
        );
      } catch (error) {
        fs.rmSync(lockPath(input.store), { recursive: true, force: true });
        throw error;
      }
      return owner;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readLockSnapshot(input.store);
      if (existing === null) continue;
      const bootedAfterOwner =
        existing.owner !== null && existing.owner.createdAt < input.now - uptime() * 1_000 - 1_000;
      const unknownOwnerStale =
        existing.owner === null &&
        (existing.mtimeMs < input.now - uptime() * 1_000 - 1_000 ||
          input.now - existing.mtimeMs >= UNKNOWN_LOCK_STALE_MS);
      const holderAlive = existing.owner !== null && input.isProcessAlive(existing.owner.pid);
      const holderStartedAt =
        holderAlive && existing.owner !== null ? input.processStartedAt(existing.owner.pid) : null;
      const stale =
        unknownOwnerStale ||
        bootedAfterOwner ||
        (existing.owner !== null && !holderAlive) ||
        (existing.owner !== null &&
          holderStartedAt !== null &&
          holderStartedAt !== existing.owner.processStartedAt);
      if (!stale)
        throw new OperatorUpdateBusyError("Resource Guardian operator update is in progress");
      if (!moveMatchingStaleLock(input.store, existing)) {
        throw new OperatorUpdateBusyError("Resource Guardian operator update lock changed owner");
      }
    }
  }
  throw new OperatorUpdateBusyError("Resource Guardian operator update is in progress");
}

function releaseLock(store: ResourceGuardianStore, owner: OperatorUpdateLockOwner): void {
  if (readLockOwner(store)?.token !== owner.token) return;
  fs.rmSync(lockPath(store), { recursive: true, force: true });
}

function removePendingBestEffort(store: ResourceGuardianStore): void {
  try {
    fs.unlinkSync(pendingPath(store));
  } catch {
    // Recovery is idempotent; a stale intent safely retries on the next tick.
  }
}

function readPending(store: ResourceGuardianStore): PendingResourceGuardianOperatorUpdate | null {
  let raw: string;
  try {
    raw = fs.readFileSync(pendingPath(store), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }
  if (!isPendingUpdate(parsed)) {
    throw new Error("Invalid Resource Guardian operator update journal");
  }
  return parsed;
}

function recoverPendingUnlocked(input: {
  store: ResourceGuardianStore;
  readEnvironment(): Map<string, string>;
}): "none" | "applied" | "discarded" {
  const pending = readPending(input.store);
  if (pending === null) return "none";
  const environment = input.readEnvironment();
  const configuredMode =
    environment.get("RESOURCE_GUARDIAN_MODE") === "protect" ? "protect" : "observe";
  const configuredProfile =
    environment.get("RESOURCE_GUARDIAN_PROFILE") === "conservative" ? "conservative" : "balanced";
  if (
    environment.get(pending.key) !== pending.value ||
    configuredMode !== pending.operator.mode ||
    configuredProfile !== pending.operator.profile
  ) {
    removePendingBestEffort(input.store);
    return "discarded";
  }
  input.store.writeOperator(pending.operator);
  removePendingBestEffort(input.store);
  return "applied";
}

/**
 * Persist config first and its live override second under one inter-process
 * lock. The journal makes every process-termination window recoverable.
 */
export function writeResourceGuardianOperatorUpdate(input: {
  store: ResourceGuardianStore;
  key: ResourceGuardianOperatorConfigKey;
  value: string;
  readEnvironment(): Map<string, string>;
  writeEnvironment(values: Record<string, string>): void;
  now: number;
}): ResourceGuardianOperatorState {
  const owner = acquireLock({
    store: input.store,
    now: input.now,
    isProcessAlive: processIsAlive,
    processStartedAt: readProcessStartedAt,
  });
  try {
    assertLockOwner(input.store, owner);
    recoverPendingUnlocked(input);
    const environment = input.readEnvironment();
    const operator: ResourceGuardianOperatorState = {
      schemaVersion: 1,
      mode:
        input.key === "RESOURCE_GUARDIAN_MODE"
          ? (input.value as ResourceGuardianOperatorState["mode"])
          : environment.get("RESOURCE_GUARDIAN_MODE") === "protect"
            ? "protect"
            : "observe",
      profile:
        input.key === "RESOURCE_GUARDIAN_PROFILE"
          ? (input.value as ResourceGuardianOperatorState["profile"])
          : environment.get("RESOURCE_GUARDIAN_PROFILE") === "conservative"
            ? "conservative"
            : "balanced",
      updatedAt: input.now,
    };
    const pending: PendingResourceGuardianOperatorUpdate = {
      schemaVersion: 1,
      key: input.key,
      value: input.value,
      operator,
      createdAt: input.now,
    };
    assertLockOwner(input.store, owner);
    writeFileAtomicSync(pendingPath(input.store), `${JSON.stringify(pending, null, 2)}\n`, {
      mode: 0o600,
    });
    assertLockOwner(input.store, owner);
    input.writeEnvironment({ [input.key]: input.value });
    assertLockOwner(input.store, owner);
    input.store.writeOperator(operator);
    assertLockOwner(input.store, owner);
    removePendingBestEffort(input.store);
    return operator;
  } finally {
    releaseLock(input.store, owner);
  }
}

/** Recover or discard a pending two-file update before reading the live override. */
export function recoverResourceGuardianOperatorUpdate(input: {
  store: ResourceGuardianStore;
  readEnvironment(): Map<string, string>;
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartedAt?: (pid: number) => string | null;
}): "none" | "applied" | "discarded" | "busy" {
  let owner: OperatorUpdateLockOwner;
  try {
    owner = acquireLock({
      store: input.store,
      now: input.now ?? Date.now(),
      isProcessAlive: input.isProcessAlive ?? processIsAlive,
      processStartedAt: input.readProcessStartedAt ?? readProcessStartedAt,
    });
  } catch (error) {
    if (error instanceof OperatorUpdateBusyError) return "busy";
    throw error;
  }
  try {
    assertLockOwner(input.store, owner);
    return recoverPendingUnlocked(input);
  } finally {
    releaseLock(input.store, owner);
  }
}

export function resourceGuardianOperatorUpdatePath(store: ResourceGuardianStore): string {
  return pendingPath(store);
}
