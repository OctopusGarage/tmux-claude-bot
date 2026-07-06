import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireInstanceLock,
  InstanceLockHeldError,
  instanceStartedAt,
  type ProcessProbe,
  releaseInstanceLock,
} from "../src/core/infra/instance-lock.js";

const lockPath = (): string => path.join(process.env.TCB_STATE_DIR ?? "", ".instance.lock");

/** Holder pid is alive AND is a real bot process → a genuine conflict. */
const botAlive: ProcessProbe = { isAlive: () => true, isBotProcess: () => true };
/** Holder pid is alive but is NOT our bot → a recycled pid → stale, take over. */
const aliveNotBot: ProcessProbe = { isAlive: () => true, isBotProcess: () => false };

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

  it("throws InstanceLockHeldError when another live bot process holds the lock", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: alivePid(), startedAt: new Date().toISOString() }),
    );
    expect(() => acquireInstanceLock(botAlive)).toThrow(InstanceLockHeldError);
    try {
      acquireInstanceLock(botAlive);
    } catch (err) {
      expect((err as InstanceLockHeldError).holder.pid).toBe(alivePid());
    }
  });

  it("takes over a lock whose pid is alive but is NOT a bot process (recycled pid)", () => {
    // B5: after a crash (SIGKILL) the OS can recycle the bot's pid for an unrelated
    // process. A liveness-only check would see it 'alive' and refuse to start
    // forever under launchd KeepAlive — the exact crash-loop the lock should
    // survive. The holder must be confirmed to actually be a bot instance.
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: alivePid(), startedAt: new Date().toISOString() }),
    );
    acquireInstanceLock(aliveNotBot);
    const holder = JSON.parse(fs.readFileSync(lockPath(), "utf8"));
    expect(holder.pid).toBe(process.pid);
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

  it("takes over a partially-written holder (valid pid but missing startedAt) even with a live-bot probe", () => {
    // A half-written lock — valid number pid, but startedAt absent — is not a
    // usable holder; it must be reclaimed, NOT trusted as a live conflict. The
    // valid pid + live-bot probe prove it's the FIELD validation (each field
    // checked independently), not the liveness check, that rejects it.
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: 4242 })); // startedAt missing
    acquireInstanceLock(botAlive);
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
  });

  it("takes over a holder whose pid is the wrong type", () => {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: "nope", startedAt: new Date().toISOString() }),
    );
    acquireInstanceLock(botAlive);
    expect(JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid).toBe(process.pid);
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

  describe("instanceStartedAt", () => {
    it("returns a parseable ISO string after acquiring the lock", () => {
      acquireInstanceLock();
      const ts = instanceStartedAt();
      expect(ts).not.toBeNull();
      if (ts === null) throw new Error("instanceStartedAt returned null");
      expect(Number.isNaN(new Date(ts).getTime())).toBe(false);
    });

    it("returns null when no lock file exists", () => {
      expect(instanceStartedAt()).toBeNull();
    });
  });
});
