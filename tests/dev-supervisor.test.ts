import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorStatus } from "../src/core/dev/supervisor-core.js";
import { startSupervisor } from "../src/scripts/dev-supervisor.js";

/** A fake ChildHandle that captures the onExit callback so tests can fire it. */
class FakeChild {
  kill = vi.fn();
  private _exitCb: (() => void) | null = null;
  onExit(cb: () => void): void {
    this._exitCb = cb;
  }
  /** Simulate the child process exiting. */
  fireExit(): void {
    this._exitCb?.();
  }
}

function makeDeps(over: Partial<Parameters<typeof startSupervisor>[0]> = {}) {
  let onChange: ((rel: string) => void) | null = null;
  const children: FakeChild[] = [];
  const statuses: SupervisorStatus[] = [];

  // Each startChild() call creates and records a new FakeChild.
  const startChild = vi.fn(() => {
    const c = new FakeChild();
    children.push(c);
    return c;
  });

  const runTypecheck = vi.fn(async () => 0 as number);

  const deps = {
    startChild,
    runTypecheck,
    watchSrc: (cb: (rel: string) => void) => {
      onChange = cb;
      return () => {};
    },
    writeStatus: (s: SupervisorStatus) => statuses.push(s),
    now: () => 1000,
    debounceMs: 50,
    backoff: { windowMs: 10_000, maxInWindow: 3, delayMs: 10 },
    ...over,
  };

  return {
    deps,
    /** children[0] is the boot child, children[1] the first respawn, etc. */
    children,
    statuses,
    startChild,
    runTypecheck,
    fire: (rel: string) => onChange?.(rel),
  };
}

/** Flush all pending timers AND async microtasks so runTypecheck promise settles.
 * A chain of resolved promises drains the microtask queue across the async await
 * boundary inside onSettled (debounce fires → onSettled starts → await runTypecheck
 * resolves → continuation runs). */
async function flushAll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  // Drain the microtask queue in several passes (each await yields once).
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startSupervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts the child once on boot", () => {
    const { deps, children } = makeDeps();
    startSupervisor(deps);
    expect(deps.startChild).toHaveBeenCalledTimes(1);
    expect(children.at(0)!.kill).not.toHaveBeenCalled();
  });

  it("on a clean typecheck after a source change, restarts the child", async () => {
    const { deps, children, startChild, runTypecheck, fire } = makeDeps();
    startSupervisor(deps);
    startChild.mockClear();
    fire("core/x.ts");
    await vi.advanceTimersByTimeAsync(60); // past debounce
    await flushAll();
    expect(runTypecheck).toHaveBeenCalledTimes(1);
    expect(children.at(0)!.kill).toHaveBeenCalledTimes(1);
    expect(startChild).toHaveBeenCalledTimes(1); // respawned
  });

  it("on a failing typecheck, holds the child and records the error", async () => {
    const { deps, children, statuses, startChild, fire } = makeDeps({
      runTypecheck: vi.fn(async () => 1),
    });
    startSupervisor(deps);
    startChild.mockClear();
    fire("core/x.ts");
    await vi.advanceTimersByTimeAsync(60);
    await flushAll();
    expect(children.at(0)!.kill).not.toHaveBeenCalled();
    expect(startChild).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.state).toBe("typecheck-failed");
  });

  it("ignores changes to test files (no typecheck, no restart)", async () => {
    const { deps, runTypecheck, fire } = makeDeps();
    startSupervisor(deps);
    fire("core/x.test.ts");
    await vi.advanceTimersByTimeAsync(60);
    expect(runTypecheck).not.toHaveBeenCalled();
  });

  // ── crash-path regression tests ──────────────────────────────────────────

  it("reload-kill: firing the OLD child's exit after a clean-typecheck reload does NOT count as a crash", async () => {
    // Bug: the shared `reloading` flag is reset synchronously before the async
    // onExit fires, so the intentional kill was counted as a crash and triggered
    // a spurious respawn. Fix: per-child intentional flag avoids this window.
    //
    // This test FAILS against the buggy code (the old exit fires, `reloading` is
    // already false, crash is counted, spurious setTimeout(startChild, 10) fires)
    // and PASSES after the fix (per-child intentional flag prevents the count).
    const { deps, children, startChild, fire } = makeDeps();
    startSupervisor(deps);
    // Boot created children[0].
    startChild.mockClear();

    // Trigger a clean-typecheck reload.
    fire("core/x.ts");
    await vi.advanceTimersByTimeAsync(60); // debounce
    await flushAll(); // typecheck promise settles → old child killed, new child started

    // At this point children[0] was killed (intentionally) and children[1] is live.
    expect(startChild).toHaveBeenCalledTimes(1); // one respawn so far
    startChild.mockClear();

    // Now simulate the OLD (killed) child's async exit event arriving AFTER reload.
    children.at(0)!.fireExit();
    // Advance past the backoff delay — any spurious respawn setTimeout would fire here.
    await vi.advanceTimersByTimeAsync(15);

    // This must NOT trigger another startChild call (no crash counted).
    expect(startChild).toHaveBeenCalledTimes(0);
  });

  it("unintentional crash triggers a respawn after the backoff delay", async () => {
    const { deps, children, startChild } = makeDeps();
    startSupervisor(deps);
    // Boot created children[0]; clear so we only count post-boot calls.
    startChild.mockClear();

    // Simulate an unintentional crash of the boot child.
    children.at(0)!.fireExit();

    // After the backoff delay (10ms in test deps), the child should be respawned.
    await vi.advanceTimersByTimeAsync(15);
    expect(startChild).toHaveBeenCalledTimes(1);
  });

  it("enough crashes in the window → nextCrashAction returns wait → no respawn, crash-wait status written", async () => {
    const now = 1000;
    const { deps, children, startChild, statuses } = makeDeps({
      now: () => now,
      backoff: { windowMs: 10_000, maxInWindow: 3, delayMs: 10 },
    });
    startSupervisor(deps);
    startChild.mockClear();

    // Fire 3 crashes in quick succession — all within the window.
    // After each crash startChild is called (respawn); the next child is children[N].
    for (let i = 0; i < 3; i++) {
      children.at(-1)!.fireExit();
      // Advance past the backoff delay so the respawn setTimeout fires (for crashes 1 & 2).
      await vi.advanceTimersByTimeAsync(15);
    }

    // 3rd crash hits maxInWindow → wait; no additional respawn.
    children.at(-1)!.fireExit();
    await vi.advanceTimersByTimeAsync(15);

    // Only 2 respawns should have happened (crashes 1 and 2 respawn; crash 3 waits).
    expect(startChild).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)?.state).toBe("crash-wait");
  });
});
