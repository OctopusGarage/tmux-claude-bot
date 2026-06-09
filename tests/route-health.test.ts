import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  chooseRoute,
  createRouteHealthStore,
  initialStats,
  recordAlive,
  recordFailure,
  recordSuccess,
  routeScore,
} from "../src/services/route-health.js";

describe("recordAlive (success without a latency sample)", () => {
  it("resets the fail streak and bumps lastOkAt but leaves EWMA untouched", () => {
    let s = recordSuccess(initialStats(), 1200, 1);
    s = recordFailure(s, 2);
    s = recordAlive(s, 5);
    expect(s.failStreak).toBe(0);
    expect(s.ewmaMs).toBe(1200); // long-poll wait time must NOT pollute the speed signal
    expect(s.lastOkAt).toBe(5);
  });
});

describe("recordSuccess", () => {
  it("seeds EWMA with the first latency sample", () => {
    const s = recordSuccess(initialStats(), 1800, 1000);
    expect(s.ewmaMs).toBe(1800);
    expect(s.failStreak).toBe(0);
    expect(s.samples).toBe(1);
    expect(s.lastOkAt).toBe(1000);
  });

  it("blends subsequent samples via EWMA and resets the fail streak", () => {
    let s = recordSuccess(initialStats(), 1000, 1);
    s = recordFailure(s, 2);
    s = recordSuccess(s, 2000, 3); // 0.3*2000 + 0.7*1000 = 1300
    expect(s.ewmaMs).toBe(1300);
    expect(s.failStreak).toBe(0);
  });
});

describe("recordFailure", () => {
  it("increments the consecutive fail streak without touching EWMA", () => {
    let s = recordSuccess(initialStats(), 1200, 1);
    s = recordFailure(s, 2);
    s = recordFailure(s, 3);
    expect(s.failStreak).toBe(2);
    expect(s.ewmaMs).toBe(1200);
  });
});

describe("routeScore (lower is better)", () => {
  it("penalizes consecutive failures heavily", () => {
    const healthy = recordSuccess(initialStats(), 2000, 1);
    const failing = recordFailure(recordSuccess(initialStats(), 1000, 1), 2);
    expect(routeScore(failing)).toBeGreaterThan(routeScore(healthy));
  });
});

describe("chooseRoute", () => {
  it("uses the default route on a cold start (no samples)", () => {
    const health = { proxy: initialStats(), direct: initialStats() };
    expect(chooseRoute(health, ["proxy", "direct"], "proxy")).toBe("proxy");
  });

  it("prefers the lower-latency route when both are healthy", () => {
    const health = {
      proxy: recordSuccess(initialStats(), 3000, 1),
      direct: recordSuccess(initialStats(), 1200, 1),
    };
    expect(chooseRoute(health, ["proxy", "direct"], "proxy")).toBe("direct");
  });

  it("avoids a route that just failed in favor of a healthy one", () => {
    const health = {
      proxy: recordFailure(recordSuccess(initialStats(), 1000, 1), 2),
      direct: recordSuccess(initialStats(), 2500, 1),
    };
    expect(chooseRoute(health, ["proxy", "direct"], "proxy")).toBe("direct");
  });

  it("returns the only route when a single one is available", () => {
    const health = { direct: initialStats() };
    expect(chooseRoute(health, ["direct"], "direct")).toBe("direct");
  });
});

describe("createRouteHealthStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-health-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("selects the default route before any data", () => {
    const store = createRouteHealthStore({
      filePath: path.join(dir, "rh.json"),
      available: ["proxy", "direct"],
      defaultRoute: "proxy",
    });
    expect(store.select()).toBe("proxy");
  });

  it("learns and persists the faster route across instances", () => {
    const filePath = path.join(dir, "rh.json");
    const store = createRouteHealthStore({
      filePath,
      available: ["proxy", "direct"],
      defaultRoute: "proxy",
    });
    store.recordSuccess("direct", 1000);
    store.recordSuccess("proxy", 4000);
    expect(store.select()).toBe("direct");

    // A fresh instance reads the persisted health and keeps the preference.
    const reopened = createRouteHealthStore({
      filePath,
      available: ["proxy", "direct"],
      defaultRoute: "proxy",
    });
    expect(reopened.select()).toBe("direct");
  });

  it("recordSuccess without a latency keeps the EWMA but clears failures (long-poll case)", () => {
    const store = createRouteHealthStore({
      available: ["proxy", "direct"],
      defaultRoute: "proxy",
    });
    store.recordSuccess("proxy", 1500);
    store.recordFailure("proxy");
    store.recordSuccess("proxy"); // long-poll success: no latency arg
    const snap = store.snapshot();
    expect(snap.proxy?.ewmaMs).toBe(1500);
    expect(snap.proxy?.failStreak).toBe(0);
  });

  it("flips away from a route that starts failing", () => {
    const store = createRouteHealthStore({
      filePath: path.join(dir, "rh.json"),
      available: ["proxy", "direct"],
      defaultRoute: "proxy",
    });
    store.recordSuccess("proxy", 1500);
    store.recordSuccess("direct", 2000);
    expect(store.select()).toBe("proxy");
    store.recordFailure("proxy");
    store.recordFailure("proxy");
    expect(store.select()).toBe("direct");
  });
});
