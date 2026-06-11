import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type KeepaliveDeps,
  type KeepaliveHandle,
  startKeepalive,
} from "../../../src/adapters/lark/keepalive.js";

const INTERVAL = 15_000;

type Status = { state: string; reconnectAttempts: number } | undefined;

function makeDeps(overrides: Partial<KeepaliveDeps> = {}): {
  deps: KeepaliveDeps;
  reconnects: () => number;
  setStatus: (s: Status) => void;
  setReachable: (r: boolean) => void;
} {
  let status: Status = { state: "connected", reconnectAttempts: 0 };
  let reachable = true;
  let reconnectCount = 0;
  const deps: KeepaliveDeps = {
    getStatus: () => status,
    probeUrl: "https://example.invalid",
    probe: async () => reachable,
    forceReconnect: async () => {
      reconnectCount++;
    },
    intervalMs: INTERVAL,
    ...overrides,
  };
  return {
    deps,
    reconnects: () => reconnectCount,
    setStatus: (s) => {
      status = s;
    },
    setReachable: (r) => {
      reachable = r;
    },
  };
}

describe("startKeepalive", () => {
  let handle: KeepaliveHandle | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    vi.useRealTimers();
  });

  it("does nothing while the channel has no status yet (pre-connect)", async () => {
    const probe = vi.fn(async () => true);
    const f = makeDeps({ getStatus: () => undefined, probe });
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(probe).not.toHaveBeenCalled();
    expect(f.reconnects()).toBe(0);
  });

  it("does nothing while connected", async () => {
    const probe = vi.fn(async () => true);
    const f = makeDeps({ probe });
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(probe).not.toHaveBeenCalled();
    expect(f.reconnects()).toBe(0);
  });

  it("force-reconnects only after 3 consecutive down ticks", async () => {
    const f = makeDeps();
    f.setStatus({ state: "reconnecting", reconnectAttempts: 2 });
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(f.reconnects()).toBe(0);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.reconnects()).toBe(1);

    // Counter resets after a reconnect — needs 3 more ticks for the next one.
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(f.reconnects()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(f.reconnects()).toBe(2);
  });

  it("does not reconnect while the network itself is unreachable", async () => {
    const f = makeDeps();
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    f.setReachable(false);
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL * 25);
    expect(f.reconnects()).toBe(0);

    // Network back: counter restarts from zero — 3 ticks to reconnect.
    f.setReachable(true);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(f.reconnects()).toBe(1);
  });

  it("a recovered connection resets the down counter", async () => {
    const f = makeDeps();
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL * 2); // down=2
    f.setStatus({ state: "connected", reconnectAttempts: 0 });
    await vi.advanceTimersByTimeAsync(INTERVAL); // recovered → reset
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2); // down=2 again — not 4

    expect(f.reconnects()).toBe(0);
  });

  it("treats a long tick gap as wake-from-sleep: resets counters, skips the tick", async () => {
    const f = makeDeps();
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL * 2); // down=2
    // Simulate sleep: jump the clock far ahead of the last tick.
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(INTERVAL); // wake-up tick: reset + skip
    await vi.advanceTimersByTimeAsync(INTERVAL * 2); // down=2 (fresh count)

    expect(f.reconnects()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL); // down=3 → reconnect
    expect(f.reconnects()).toBe(1);
  });

  it("skips ticks that fire too close together (timer storm on wake)", async () => {
    const probe = vi.fn(async () => true);
    const f = makeDeps({ probe, intervalMs: 1_000 }); // < storm guard (5s)
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    handle = startKeepalive(f.deps);

    // Ticks fire every 1s but the guard only lets one through per 5s window:
    // of the 10 ticks in 10s, only t=1s and t=6s run.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("a failing forceReconnect is logged, not thrown", async () => {
    const f = makeDeps({
      forceReconnect: async () => {
        throw new Error("boom");
      },
    });
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    handle = startKeepalive(f.deps);

    await expect(vi.advanceTimersByTimeAsync(INTERVAL * 4)).resolves.not.toThrow();
  });

  it("a throwing probe is caught by the tick error handler", async () => {
    const f = makeDeps({
      probe: async () => {
        throw new Error("probe blew up");
      },
    });
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    handle = startKeepalive(f.deps);

    await expect(vi.advanceTimersByTimeAsync(INTERVAL * 2)).resolves.not.toThrow();
    expect(f.reconnects()).toBe(0);
  });

  it("default HTTP probe treats any response as reachable and errors as not", async () => {
    const f = makeDeps({ probe: undefined });
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });

    // Host answers (even with 5xx) → reachable → down-counter advances to
    // the reconnect threshold.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 503 })),
    );
    handle = startKeepalive(f.deps);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(f.reconnects()).toBe(1);
    handle.stop();

    // fetch rejects (DNS/socket error) → unreachable → never reconnects.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    handle = startKeepalive(f.deps);
    await vi.advanceTimersByTimeAsync(INTERVAL * 6);
    expect(f.reconnects()).toBe(1);

    vi.unstubAllGlobals();
  });

  it("stop() halts the loop", async () => {
    const probe = vi.fn(async () => true);
    const f = makeDeps({ probe });
    f.setStatus({ state: "reconnecting", reconnectAttempts: 1 });
    handle = startKeepalive(f.deps);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);

    handle.stop();
    handle = undefined;
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
