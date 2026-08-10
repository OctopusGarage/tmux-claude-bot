import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DailyTaskLedger,
  SCHEDULED_TASK_SOURCES,
  singaporeDayWindow,
} from "../../src/core/tasks/task-ledger.js";
import { recordExternalTaskReport } from "../../src/core/tasks/task-report.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("recordExternalTaskReport", () => {
  it("records an autopilot delegation repair status in the shared task ledger", () => {
    expect(SCHEDULED_TASK_SOURCES).toContain("autopilot-delegate");
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-autopilot-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");

    recordExternalTaskReport({
      taskId: "autopilot:delegation:2026-07-27",
      source: "autopilot-delegate",
      name: "autopilot delegated task",
      scheduledAt,
      status: "failed",
      error: "invalid final summary",
      repairStatus: "fixed",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "autopilot:delegation:2026-07-27",
      source: "autopilot-delegate",
      repairStatus: "fixed",
    });
  });

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

  it("records repair status updates through the shared task report contract", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-repair-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:2026-07-27",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "failed",
      error: "report file was not generated",
    });
    recordExternalTaskReport({
      taskId: "radar:daily:2026-07-27",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "failed",
      error: "repair verified the report generator",
      summary: "fixed by dev branch repair commit",
      repairStatus: "fixed",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:2026-07-27",
      status: "failed",
      error: "repair verified the report generator",
      summary: "fixed by dev branch repair commit",
      repairStatus: "fixed",
    });
  });

  it("records successful external task reports with summary and report path evidence", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-success-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");
    const endedAt = Date.parse("2026-07-27T03:05:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:success",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "success",
      endedAt,
      summary: "generated daily radar report",
      reportPath: "/tmp/radar-report.json",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:success",
      status: "success",
      endedAt,
      summary: "generated daily radar report",
      reportPath: "/tmp/radar-report.json",
      repairStatus: "not-needed",
      updatedAt: endedAt,
    });
  });

  it("records skipped external task reports without marking them repairable", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-skipped-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");
    const endedAt = Date.parse("2026-07-27T03:01:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:skipped",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "skipped",
      endedAt,
      summary: "outside monitoring window",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:skipped",
      status: "skipped",
      endedAt,
      summary: "outside monitoring window",
      repairStatus: "not-needed",
      updatedAt: endedAt,
    });
  });

  it("uses the contract default error when a failed external report omits one", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-default-error-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:default-error",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "failed",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:default-error",
      status: "failed",
      error: "external task reported failure",
      repairStatus: "pending",
    });
  });

  it("records running external task reports with the supplied start time", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-running-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");
    const startedAt = Date.parse("2026-07-27T03:02:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:running",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "running",
      startedAt,
      summary: "monitor is collecting signals",
      repairStatus: "running",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:running",
      status: "running",
      startedAt,
      summary: "monitor is collecting signals",
      repairStatus: "running",
      updatedAt: startedAt,
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

  it("rejects invalid scheduled and ended timestamps before writing ledger records", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-invalid-terminal-"));

    expect(() =>
      recordExternalTaskReport({
        taskId: "radar:daily:bad-scheduled",
        source: "radar-monitor",
        name: "daily radar monitor",
        scheduledAt: Number.POSITIVE_INFINITY,
        status: "success",
        endedAt: Date.parse("2026-07-27T03:05:00Z"),
      }),
    ).toThrow("invalid scheduledAt");

    expect(() =>
      recordExternalTaskReport({
        taskId: "radar:daily:bad-ended",
        source: "radar-monitor",
        name: "daily radar monitor",
        scheduledAt: Date.parse("2026-07-27T03:00:00Z"),
        status: "success",
        endedAt: Number.NaN,
      }),
    ).toThrow("invalid endedAt");

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))).toEqual([]);
  });
});
