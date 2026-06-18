import { describe, expect, it } from "vitest";
import { argsToFilter } from "../src/core/logs/log-query.js";

describe("argsToFilter", () => {
  it("maps CLI options to a LogFilter", () => {
    expect(argsToFilter({ session: "s1", trace: "t2", level: "WARN", n: "10" })).toEqual({
      session: "s1",
      trace: "t2",
      levelMin: "WARN",
      n: 10,
    });
  });

  it("returns an empty filter for no options", () => {
    expect(argsToFilter({})).toEqual({});
  });
});
