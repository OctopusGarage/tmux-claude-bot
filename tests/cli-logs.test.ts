import { describe, expect, it } from "vitest";
import { argsToFilter } from "../src/core/logs/log-query.js";

describe("argsToFilter", () => {
  it("maps CLI options to a LogFilter", () => {
    expect(
      argsToFilter({
        session: "s1",
        trace: "t2",
        level: "WARN",
        n: "10",
        since: "2026-06-18T01:00:00Z",
        runId: "run-1",
      }),
    ).toEqual({
      session: "s1",
      trace: "t2",
      levelMin: "WARN",
      since: Date.parse("2026-06-18T01:00:00Z"),
      runId: "run-1",
      n: 10,
    });
  });

  it("returns an empty filter for no options", () => {
    expect(argsToFilter({})).toEqual({});
  });

  it("normalizes a lowercase level", () => {
    expect(argsToFilter({ level: "warn" })).toEqual({ levelMin: "WARN" });
  });

  it("rejects an unknown level instead of silently letting all levels through", () => {
    expect(() => argsToFilter({ level: "inof" })).toThrow(/invalid --level/);
  });

  it("rejects a non-numeric N instead of silently disabling the cap", () => {
    expect(() => argsToFilter({ n: "abc" })).toThrow(/invalid -n/);
  });

  it("rejects a non-positive N", () => {
    expect(() => argsToFilter({ n: "0" })).toThrow(/invalid -n/);
  });

  it("parses relative --since values", () => {
    const now = Date.parse("2026-06-18T02:00:00Z");
    expect(argsToFilter({ since: "30m" }, now)).toEqual({ since: now - 30 * 60 * 1000 });
    expect(argsToFilter({ since: "2h" }, now)).toEqual({ since: now - 2 * 60 * 60 * 1000 });
  });

  it("rejects an invalid --since value", () => {
    expect(() => argsToFilter({ since: "recently" })).toThrow(/invalid --since/);
  });
});
