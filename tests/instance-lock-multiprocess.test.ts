import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Real cross-process check for the single-instance lock. The unit tests mock fs
 * (deterministic TOCTOU) and exercise single-process behaviors; this spawns two
 * actual processes against the same state dir to prove the lock the bot depends
 * on — a second instance must refuse while the first holds it (the 409 guard).
 * Deterministic, not timing-based: B only starts after A reports it holds.
 */
const TSX = nodePath.resolve("node_modules/.bin/tsx");
const HELPER = nodePath.resolve("tests/helpers/lock-acquirer.ts");

let procs: ChildProcess[] = [];

function spawnAcquirer(stateDir: string, holdMs: number): ChildProcess {
  const p = spawn(TSX, [HELPER], {
    env: { ...process.env, TCB_STATE_DIR: stateDir, HOLD_MS: String(holdMs) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  procs.push(p);
  return p;
}

/** Resolve when the child's stdout has printed `token`. */
function waitForOutput(p: ChildProcess, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    p.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(token)) resolve();
    });
    p.on("exit", () =>
      buf.includes(token) ? resolve() : reject(new Error(`no ${token}: ${buf}`)),
    );
    p.on("error", reject);
  });
}

/** Resolve with the child's full stdout once it exits. */
function collect(p: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    p.stdout?.on("data", (d: Buffer) => (buf += d.toString()));
    p.on("exit", () => resolve(buf));
    p.on("error", reject);
  });
}

describe("instance lock across real processes", () => {
  afterEach(() => {
    for (const p of procs) p.kill("SIGKILL");
    procs = [];
  });

  it("a second process refuses while the first holds the lock", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-lock-mp-"));

    // A acquires and holds; wait until it reports it holds before starting B.
    const a = spawnAcquirer(dir, 5000);
    await waitForOutput(a, "ACQUIRED");

    // B, against the same state dir, must refuse.
    const b = spawnAcquirer(dir, 0);
    const bOut = await collect(b);

    expect(bOut).toContain("HELD");
    expect(bOut).not.toContain("ACQUIRED");
  }, 30_000);

  it("a fresh process acquires once the holder has exited", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tcb-lock-mp-"));

    const a = spawnAcquirer(dir, 0); // acquires and exits immediately (releases)
    expect(await collect(a)).toContain("ACQUIRED");

    const b = spawnAcquirer(dir, 0); // the lock is free again
    expect(await collect(b)).toContain("ACQUIRED");
  }, 30_000);
});
