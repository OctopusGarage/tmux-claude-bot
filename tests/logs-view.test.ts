import { describe, expect, it } from "vitest";
import type { LogRecord } from "../src/core/logs/log-query.js";
import { formatLogsForChat, logsArgToFilter } from "../src/core/logs/logs-view.js";

const recs: LogRecord[] = [
  { ts: "2026-06-18T01:00:00Z", level: "ERROR", component: "a", msg: "boom", traceId: "t1" },
  { ts: "2026-06-18T01:00:01Z", level: "WARN", component: "b", msg: "careful", traceId: "t1" },
];

describe("formatLogsForChat", () => {
  it("renders a compact, capped block newest-last", () => {
    const out = formatLogsForChat(recs, { maxChars: 4000 });
    expect(out).toContain("boom");
    expect(out).toContain("ERROR");
    expect(out.length).toBeLessThanOrEqual(4000);
  });
  it("returns a friendly message when empty", () => {
    expect(formatLogsForChat([], { maxChars: 4000 })).toMatch(/no.*log/i);
  });
});

describe("logsArgToFilter", () => {
  it("defaults chat log lookup to the current session and recent records", () => {
    const now = Date.parse("2026-06-18T02:00:00Z");
    expect(logsArgToFilter(undefined, "tmux_proj_app", now)).toEqual({
      session: "tmux_proj_app",
      levelMin: "WARN",
      since: now - 60 * 60 * 1000,
      n: 30,
    });
  });
});
