import { describe, expect, it } from "vitest";
import {
  createCachingCheckRunner,
  execCheckRunner,
} from "../../src/core/autopilot/check-runner.js";

const flush = () => new Promise((r) => setImmediate(r));

describe("execCheckRunner", () => {
  it("maps the command's exit code to ok (0 → ok, non-zero → not ok)", async () => {
    expect(await execCheckRunner("exit 0", undefined)).toEqual({ ok: true });
    expect(await execCheckRunner("exit 3", undefined)).toEqual({ ok: false });
  });
});

describe("createCachingCheckRunner", () => {
  it("never blocks: returns immediately, refreshes in background, caches within TTL", async () => {
    let calls = 0;
    const base = async () => {
      calls += 1;
      return { ok: true };
    };
    let t = 0;
    const runner = createCachingCheckRunner(base, 1000, () => t);

    // First call: no cache yet → kicks off base in the background, returns
    // pending (not done, but distinguishable from a real failure) right now.
    expect(await runner("npm test", undefined)).toEqual({ ok: false, pending: true });
    await flush(); // let the background base resolve into the cache

    // Within TTL: returns the cached pass (no pending flag) without re-running base.
    expect(await runner("npm test", undefined)).toEqual({ ok: true });
    expect(calls).toBe(1);

    // Past TTL: triggers a single background refresh.
    t = 2000;
    await runner("npm test", undefined);
    await flush();
    expect(calls).toBe(2);
  });

  it("keys by cmd+cwd (different commands don't share a result)", async () => {
    const base = async (cmd: string) => ({ ok: cmd === "pass" });
    const runner = createCachingCheckRunner(base, 1000, () => 0);
    await runner("pass", undefined);
    await runner("fail", undefined);
    await flush();
    expect(await runner("pass", undefined)).toEqual({ ok: true });
    expect(await runner("fail", undefined)).toEqual({ ok: false });
  });
});
