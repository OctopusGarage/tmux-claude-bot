import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DailyTaskLedger, singaporeDayWindow } from "../../src/core/tasks/task-ledger.js";
import { recordExternalTaskReport } from "../../src/core/tasks/task-report.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("recordExternalTaskReport", () => {
  it("records an external radar monitor failure in the shared task ledger", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:2026-07-27",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "failed",
      error: "report file was not generated",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:2026-07-27",
      source: "radar-monitor",
      status: "failed",
      error: "report file was not generated",
    });
  });

  it("rejects invalid task timestamps before writing corrupt ledger records", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-invalid-"));

    expect(() =>
      recordExternalTaskReport({
        taskId: "radar:daily:invalid",
        source: "radar-monitor",
        name: "daily radar monitor",
        scheduledAt: Date.parse("2026-07-27T03:00:00Z"),
        status: "running",
        startedAt: Number.NaN,
      }),
    ).toThrow("invalid startedAt");

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))).toEqual([]);
  });
});
