import { describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/utils/logger.js", () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: log, createLogger: () => log };
});

import type { RouteHealthStore } from "../src/adapters/telegram/transport/route-health.js";
import { createSmartFetch } from "../src/adapters/telegram/transport/smart-fetch.js";

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

  it("records a success (no latency) for a long-poll call that resolves", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [{ name: "proxy", fetch: vi.fn().mockResolvedValue({ status: 200 }) }],
      health,
      timeoutMs: 1000,
      isLongPoll: (url) => url.includes("/getUpdates"),
    });
    await smart("https://api/getUpdates", {});
    expect(health.successes[0]).toEqual(["proxy", undefined]);
  });

  it("describe() uses String(err) for a non-Error long-poll failure", async () => {
    const { logger } = await import("../src/shared/utils/logger.js");
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [{ name: "proxy", fetch: vi.fn().mockRejectedValue("string-error") }],
      health,
      timeoutMs: 1000,
      isLongPoll: (url) => url.includes("/getUpdates"),
    });
    await expect(smart("https://api/getUpdates", {})).rejects.toBe("string-error");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining("string-error"));
  });

  it("respects a pre-aborted signal (callWithTimeout aborts immediately)", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [
        { name: "proxy", fetch: vi.fn().mockResolvedValue({ status: 200 }) },
        { name: "direct", fetch: vi.fn().mockResolvedValue({ status: 200 }) },
      ],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    const controller = new AbortController();
    controller.abort(); // pre-aborted
    // Should still resolve (abort just stops waiting, race with fetch)
    const res = await smart("https://api/send", { signal: controller.signal });
    expect(res).toBeDefined();
  });

  it("propagates an external AbortSignal (non-aborted) through callWithTimeout", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [{ name: "proxy", fetch: vi.fn().mockResolvedValue({ status: 200 }) }],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    const controller = new AbortController();
    const res = await smart("https://api/send", { signal: controller.signal });
    expect(res).toBeDefined();
  });

  it("throws immediately when no routes are configured", async () => {
    const health = fakeHealth("proxy");
    const smart = createSmartFetch({
      routes: [],
      health,
      timeoutMs: 1000,
      isLongPoll: notLongPoll,
    });
    await expect(smart("https://api/send", {})).rejects.toThrow("no routes configured");
  });

  it("fails over to the next route when a long-poll call errors", async () => {
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
    const res = (await smart("https://api/getUpdates", {})) as { via: string };
    expect(res.via).toBe("direct");
    expect(direct).toHaveBeenCalled();
    expect(health.failures).toEqual(["proxy"]);
    expect(health.successes[0]).toEqual(["direct", undefined]);
  });
});
