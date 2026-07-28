import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DailyTaskLedger,
  singaporeDayWindow,
  summarizeTaskWindow,
} from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("DailyTaskLedger", () => {
  it("summarizes completed, failed, and missing scheduled tasks for a Singapore day", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-"));
    const ledger = new DailyTaskLedger();
    const expectedAt = Date.parse("2026-07-27T01:00:00Z");
    const failedAt = Date.parse("2026-07-27T03:00:00Z");
    const missingAt = Date.parse("2026-07-27T05:00:00Z");

    ledger.expect({
      taskId: "loop:geo-backend:1785133200000",
      source: "loop-engineering",
      name: "geo-backend architecture",
      scheduledAt: expectedAt,
    });
    ledger.start("loop:geo-backend:1785133200000", expectedAt + 1000);
    ledger.finish("loop:geo-backend:1785133200000", {
      endedAt: expectedAt + 10_000,
      summary: "completed",
      reportPath: "/state/loop-runs/geo-backend/report.md",
    });

    ledger.expect({
      taskId: "radar:daily:1785140400000",
      source: "radar-monitor",
      name: "daily radar",
      scheduledAt: failedAt,
    });
    ledger.fail("radar:daily:1785140400000", {
      endedAt: failedAt + 1000,
      error: "fetch returned 500",
    });

    ledger.expect({
      taskId: "article:daily:1785147600000",
      source: "article-monitor",
      name: "daily article monitor",
      scheduledAt: missingAt,
    });

    const summary = summarizeTaskWindow({
      records: ledger.listForWindow(singaporeDayWindow("2026-07-27")),
      now: Date.parse("2026-07-28T01:05:00Z"),
    });

    expect(summary.counts).toEqual({
      success: 1,
      failed: 1,
      missing: 1,
      running: 0,
      runningTimeout: 0,
      skipped: 0,
    });
    expect(summary.items.map((item) => [item.taskId, item.status])).toEqual([
      ["loop:geo-backend:1785133200000", "success"],
      ["radar:daily:1785140400000", "failed"],
      ["article:daily:1785147600000", "missing"],
    ]);
  });

  it("does not mark a still-running task as timed out before the timeout window", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-running-"));
    const ledger = new DailyTaskLedger();
    const scheduledAt = Date.parse("2026-07-27T18:00:00Z");
    const startedAt = scheduledAt + 1000;
    ledger.expect({
      taskId: "batch:nightly:running",
      source: "batch-scheduler",
      name: "nightly batch",
      scheduledAt,
    });
    ledger.start("batch:nightly:running", startedAt);

    const summary = summarizeTaskWindow({
      records: ledger.listForWindow(singaporeDayWindow("2026-07-28")),
      now: startedAt + 60 * 60 * 1000,
    });

    expect(summary.counts).toEqual({
      success: 0,
      failed: 0,
      missing: 0,
      running: 1,
      runningTimeout: 0,
      skipped: 0,
    });
    expect(summary.items[0]).toMatchObject({
      taskId: "batch:nightly:running",
      status: "running",
    });
  });

  it("marks a running task as timed out after the timeout window", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-timeout-"));
    const ledger = new DailyTaskLedger();
    const scheduledAt = Date.parse("2026-07-27T01:00:00Z");
    ledger.expect({
      taskId: "batch:nightly:timeout",
      source: "batch-scheduler",
      name: "nightly batch",
      scheduledAt,
    });
    ledger.start("batch:nightly:timeout", scheduledAt + 1000);

    const summary = summarizeTaskWindow({
      records: ledger.listForWindow(singaporeDayWindow("2026-07-27")),
      now: scheduledAt + 13 * 60 * 60 * 1000,
    });

    expect(summary.counts.running).toBe(0);
    expect(summary.counts.runningTimeout).toBe(1);
    expect(summary.items[0]).toMatchObject({
      taskId: "batch:nightly:timeout",
      status: "running-timeout",
      repairStatus: "pending",
    });
  });
});
