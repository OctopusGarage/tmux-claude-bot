import { describe, expect, it } from "vitest";
import { filterRecords, type LogRecord } from "../src/core/logs/log-query.js";

const recs: LogRecord[] = [
  {
    ts: "2026-06-18T01:00:00Z",
    level: "INFO",
    component: "a",
    msg: "x",
    traceId: "t1",
    session: "s1",
    channel: "lark",
  },
  {
    ts: "2026-06-18T01:00:01Z",
    level: "ERROR",
    component: "b",
    msg: "boom",
    traceId: "t2",
    session: "s2",
    channel: "telegram",
  },
  {
    ts: "2026-06-18T01:00:02Z",
    level: "DEBUG",
    component: "a",
    msg: "noise",
    traceId: "t1",
    session: "s1",
  },
];

describe("filterRecords", () => {
  it("filters by session", () => {
    expect(filterRecords(recs, { session: "s1" }).map((r) => r.msg)).toEqual(["x", "noise"]);
  });
  it("filters by trace", () => {
    expect(filterRecords(recs, { trace: "t2" }).map((r) => r.msg)).toEqual(["boom"]);
  });
  it("filters by minimum level", () => {
    expect(filterRecords(recs, { levelMin: "ERROR" }).map((r) => r.msg)).toEqual(["boom"]);
  });
  it("filters by grep substring (case-insensitive)", () => {
    expect(filterRecords(recs, { grep: "BOOM" }).map((r) => r.msg)).toEqual(["boom"]);
  });
  it("filters by run id across structured fields", () => {
    expect(
      filterRecords(
        [
          ...recs,
          {
            ts: "2026-06-18T01:00:03Z",
            level: "INFO",
            component: "loop.service",
            msg: "accepted",
            data: { runId: "run-42" },
          },
        ],
        { runId: "run-42" },
      ).map((r) => r.msg),
    ).toEqual(["accepted"]);
  });
  it("filters by since timestamp", () => {
    expect(
      filterRecords(recs, { since: Date.parse("2026-06-18T01:00:01Z") }).map((r) => r.msg),
    ).toEqual(["boom", "noise"]);
  });
  it("limits newest-last with n", () => {
    expect(filterRecords(recs, { session: "s1", n: 1 }).map((r) => r.msg)).toEqual(["noise"]);
  });
});
