import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireInstanceLock,
  InstanceLockHeldError,
  releaseInstanceLock,
} from "../src/core/instance-lock.js";

const lockPath = (): string => path.join(process.env.TCB_STATE_DIR ?? "", ".instance.lock");

/** A pid that is guaranteed dead: spawn a short-lived child and let it exit. */
function deadPid(): number {
  const result = spawnSync("true");
  if (typeof result.pid !== "number") throw new Error("failed to spawn child for dead pid");
  return result.pid;
}

/** A pid that is alive and is not this process: the test runner's parent. */
function alivePid(): number {
  return process.ppid;
}

describe("instance lock", () => {
  beforeEach(() => {
    // Fresh state dir per test; state-dir.ts reads the env on every call.
    process.env.TCB_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tcb-lock-test-"));
  });

  it("acquires the lock when none exists and records our pid", () => {
    acquireInstanceLock();
    const holder = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(typeof holder.startedAt).toBe("string");
  });

  it("throws InstanceLockHeldError when another live process holds the lock", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: alivePid(), startedAt: new Date().toISOString() }),
    );
    expect(() => acquireInstanceLock()).toThrow(InstanceLockHeldError);
    try {
      acquireInstanceLock();
    } catch (err) {
      expect((err as InstanceLockHeldError).holder.pid).toBe(alivePid());
    }
  });

  it("takes over a stale lock whose holder is dead", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }),
    );
    acquireInstanceLock();
    const holder = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    expect(holder.pid).toBe(process.pid);
  });

  it("takes over a corrupt lock file", () => {
    fs.writeFileSync(lockPath(), "not json");
    acquireInstanceLock();
    const holder = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    expect(holder.pid).toBe(process.pid);
  });

  it("release removes the lock file we hold", () => {
    acquireInstanceLock();
    releaseInstanceLock();
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("release leaves a lock held by another process untouched", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: alivePid(), startedAt: new Date().toISOString() }),
    );
    releaseInstanceLock();
    expect(fs.existsSync(lockPath())).toBe(true);
  });
});
