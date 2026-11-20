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
  it.each(["missing", "failed", "running-timeout"])(
    "updates repair status without rewriting %s task execution metadata",
    (status) => {
      process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-unchanged-"));
      const ledger = new DailyTaskLedger();
      const original = {
        taskId: "loop:sample:missing",
        source: "loop-engineering" as const,
        name: "sample architecture",
        scheduledAt: 1_000,
      };
      ledger.expect(original);
      if (status === "missing") ledger.reconcileExpectedMissing(2_000);
      else if (status === "failed")
        ledger.fail(original.taskId, {
          endedAt: 2_000,
          error: "original error",
          failureKind: "system-gate",
          reportPath: "/tmp/original-report.json",
        });
      else {
        ledger.start(original.taskId, 1_000);
        ledger.reconcileStaleRunning(2_000, { timeoutMs: 1 });
      }
      const before = ledger.listAll().find((task) => task.taskId === original.taskId);

      recordExternalTaskReport({
        ...original,
        status: "unchanged",
        repairStatus: "blocked",
        summary: "Historical completion evidence unavailable",
      });

      expect(ledger.listAll().find((task) => task.taskId === original.taskId)).toEqual({
        ...before,
        repairStatus: "blocked",
        summary: "Historical completion evidence unavailable",
        updatedAt: expect.any(Number),
      });
    },
  );

  it("rejects repair-only reports for unknown tasks", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-unknown-"));
    expect(() =>
      recordExternalTaskReport({
        taskId: "unknown",
        source: "loop-engineering",
        name: "unknown",
        scheduledAt: 1_000,
        status: "unchanged",
        repairStatus: "blocked",
      }),
    ).toThrow("requires an existing task");
    expect(new DailyTaskLedger().listAll()).toEqual([]);
  });

  it("rejects repair-only reports that change identity or execution fields", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-identity-"));
    const ledger = new DailyTaskLedger();
    const identity = {
      taskId: "sample",
      source: "loop-engineering" as const,
      name: "sample",
      scheduledAt: 1_000,
    };
    ledger.expect(identity);
    const before = ledger.listAll();
    for (const patch of [
      { name: "different" },
      { scheduledAt: 2_000 },
      { source: "launchd" as const },
      { startedAt: 2_000 },
      { endedAt: 2_000 },
      { error: "different" },
      { reportPath: "/tmp/different" },
    ]) {
      expect(() =>
        recordExternalTaskReport({
          ...identity,
          status: "unchanged",
          repairStatus: "blocked",
          ...patch,
        }),
      ).toThrow();
      expect(ledger.listAll()).toEqual(before);
    }
  });

  it("requires a repair status for unchanged reports", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-repair-required-"));
    const ledger = new DailyTaskLedger();
    const identity = {
      taskId: "sample",
      source: "loop-engineering" as const,
      name: "sample",
      scheduledAt: 1_000,
    };
    ledger.expect(identity);
    const before = ledger.listAll();
    expect(() => recordExternalTaskReport({ ...identity, status: "unchanged" })).toThrow(
      "requires a repair status",
    );
    expect(ledger.listAll()).toEqual(before);
  });

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

  it("does not reopen a successful task when a stale running report arrives later", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-report-stale-running-"));
    const scheduledAt = Date.parse("2026-07-27T03:00:00Z");
    const endedAt = Date.parse("2026-07-27T03:05:00Z");

    recordExternalTaskReport({
      taskId: "radar:daily:stale-running",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "success",
      endedAt,
      summary: "generated report",
    });
    recordExternalTaskReport({
      taskId: "radar:daily:stale-running",
      source: "radar-monitor",
      name: "daily radar monitor",
      scheduledAt,
      status: "running",
      startedAt: scheduledAt + 1_000,
      summary: "late heartbeat",
    });

    expect(new DailyTaskLedger().listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "radar:daily:stale-running",
      status: "success",
      endedAt,
      summary: "generated report",
      repairStatus: "not-needed",
      updatedAt: endedAt,
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
