import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterRecords,
  formatLogSummary,
  type LogRecord,
  readLogReport,
  summarizeLogs,
} from "../src/core/logs/log-query.js";

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

describe("summarizeLogs", () => {
  it("builds a bounded diagnostic summary with top components and repeated issues", () => {
    const repeated = recs[1];
    if (repeated === undefined) throw new Error("missing repeated issue fixture");
    const summary = summarizeLogs(
      [
        ...recs,
        { ...repeated, ts: "2026-06-18T01:00:03Z" },
        { ...repeated, ts: "2026-06-18T01:00:04Z" },
      ],
      { files: 2, bytes: 2048, malformedLines: 1 },
    );

    expect(summary).toMatchObject({
      records: 5,
      files: 2,
      bytes: 2048,
      malformedLines: 1,
      levels: { DEBUG: 1, INFO: 1, WARN: 0, ERROR: 3 },
      topIssues: [{ level: "ERROR", component: "b", message: "boom", count: 3 }],
    });
    expect(formatLogSummary(summary)).toContain("3 ERROR");
    expect(formatLogSummary(summary)).toContain("1 malformed");
  });
});

describe("readLogReport", () => {
  const originalLogDir = process.env.TCB_LOG_DIR;
  afterEach(() => {
    if (originalLogDir === undefined) delete process.env.TCB_LOG_DIR;
    else process.env.TCB_LOG_DIR = originalLogDir;
  });

  it("reports malformed complete records but ignores a torn live tail", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "tcb-log-report-"));
    process.env.TCB_LOG_DIR = dir;
    const valid = JSON.stringify({
      ts: "2026-06-18T01:00:00Z",
      level: "INFO",
      component: "boot",
      msg: "started",
    });
    fs.writeFileSync(join(dir, "tcb-20260618.jsonl"), `${valid}\nnot-json\n{"torn":`);

    expect(readLogReport(1)).toMatchObject({
      records: [expect.objectContaining({ msg: "started" })],
      files: 1,
      malformedLines: 1,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
