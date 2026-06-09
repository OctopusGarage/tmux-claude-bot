import { describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { RouteHealthStore } from "../src/services/route-health.js";
import { createSmartFetch } from "../src/services/smart-fetch.js";

function fakeHealth(preferred: string): RouteHealthStore & {
  successes: Array<[string, number | undefined]>;
  failures: string[];
} {
  const successes: Array<[string, number | undefined]> = [];
  const failures: string[] = [];
  return {
    successes,
    failures,
    select: () => preferred,
    recordSuccess: (route, ms) => successes.push([route, ms]),
    recordFailure: (route) => failures.push(route),
    snapshot: () => ({}),
  };
}

const notLongPoll = () => false;

describe("createSmartFetch", () => {
  it("uses the preferred route and records its success", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: vi.fn().mockResolvedValue({ status: 200, via: "proxy" }) },
        { name: "direct", fetch: vi.fn().mockResolvedValue({ status: 200, via: "direct" }) },
      ],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    const res = (await smart("https://api/sendMessage", {})) as { via: string };
    expect(res.via).toBe("proxy");
    expect(health.successes[0]?.[0]).toBe("proxy");
    expect(health.failures).toEqual([]);
  });

  it("falls over to the other route when the preferred one fails", async () => {
    const health = fakeHealth("proxy");
    const direct = vi.fn().mockResolvedValue({ status: 200, via: "direct" });
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: vi.fn().mockRejectedValue(new Error("ECONNRESET")) },
        { name: "direct", fetch: direct },
      ],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    const res = (await smart("https://api/sendMessage", {})) as { via: string };
    expect(res.via).toBe("direct");
    expect(health.failures).toEqual(["proxy"]);
    expect(health.successes[0]?.[0]).toBe("direct");
  });

  it("tries the learned-preferred route first", async () => {
    const health = fakeHealth("direct");
    const proxy = vi.fn().mockResolvedValue({ status: 200, via: "proxy" });
    const direct = vi.fn().mockResolvedValue({ status: 200, via: "direct" });
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: proxy },
        { name: "direct", fetch: direct },
      ],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    const res = (await smart("https://api/sendMessage", {})) as { via: string };
    expect(res.via).toBe("direct");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("fails over when the preferred route exceeds the timeout", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: () => new Promise(() => {}) }, // never resolves
        { name: "direct", fetch: vi.fn().mockResolvedValue({ status: 200, via: "direct" }) },
      ],
      health,
      timeoutMs: 25,
      isLongPoll: notLongPoll,
    });
    const res = (await smart("https://api/sendMessage", {})) as { via: string };
    expect(res.via).toBe("direct");
    expect(health.failures).toEqual(["proxy"]);
  });

  it("throws when every route fails", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: vi.fn().mockRejectedValue(new Error("a")) },
        { name: "direct", fetch: vi.fn().mockRejectedValue(new Error("b")) },
      ],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    await expect(smart("https://api/sendMessage", {})).rejects.toThrow();
    expect(health.failures).toEqual(["proxy", "direct"]);
  });

  it("does NOT fail over for a long-poll (getUpdates) call", async () => {
    const health = fakeHealth("proxy");
    const direct = vi.fn().mockResolvedValue({ status: 200, via: "direct" });
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: vi.fn().mockRejectedValue(new Error("ECONNRESET")) },
        { name: "direct", fetch: direct },
      ],
      health,
      timeoutMs: 1000,
      isLongPoll: (url) => url.includes("/getUpdates"),
    });
    await expect(smart("https://api/getUpdates", {})).rejects.toThrow();
    expect(direct).not.toHaveBeenCalled(); // long poll never fails over
    expect(health.failures).toEqual(["proxy"]);
  });
});
