import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDailyTaskAuditNotification,
  renderDailyTaskAudit,
  runDailyTaskAudit,
} from "../../src/core/tasks/daily-audit.js";
import type { TaskAuditItem } from "../../src/core/tasks/task-ledger.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("runDailyTaskAudit", () => {
  it("renders a compact audit summary without task paths or verbose raw errors", () => {
    const body = renderDailyTaskAudit(
      {
        window: { start: 0, end: 1, label: "2026-08-04 SGT" },
        counts: {
          success: 3,
          failed: 2,
          missing: 1,
          running: 0,
          runningTimeout: 0,
          skipped: 0,
        },
        items: [
          {
            taskId: "loop:demo:test-coverage:1",
            source: "loop-engineering",
            name: "demo test-coverage",
            scheduledAt: 1,
            status: "failed",
            failureKind: "system-gate",
            error: `system gate failed at ${homedir()}/project/report.json`,
            reportPath: `${homedir()}/project/report.md`,
            repairStatus: "pending",
            updatedAt: 1,
          },
        ],
      },
      [],
      { repairDispatch: "queued" },
    );

    expect(body).toContain("Status: ATTENTION");
    expect(body).toContain("Counts: 3 success · 2 failed · 1 missing · 0 running");
    expect(body).toContain("Repair: 0 candidates · queued");
    expect(body).toContain("demo test-coverage · failed · system-gate");
    expect(body).not.toContain("taskId:");
    expect(body).not.toContain("report:");
    expect(body).not.toContain(homedir());
  });

  it("renders an explicit empty audit summary when the window has no records", () => {
    const body = renderDailyTaskAudit(
      {
        window: null,
        counts: {
          success: 0,
          failed: 0,
          missing: 0,
          running: 0,
          runningTimeout: 0,
          skipped: 0,
        },
        items: [],
      },
      [],
    );

    expect(body).toContain("Status: OK");
    expect(body).toContain("Repair: 0 candidates");
    expect(body).toContain("No scheduled task records found.");
  });

  it("counts closed failures when a repair dispatch result is rendered", () => {
    const closedFailure = taskAuditItem({
      taskId: "loop:closed",
      name: "closed repair",
      status: "failed",
      repairStatus: "fixed",
    });
    const activeFailure = taskAuditItem({
      taskId: "loop:active",
      name: "active repair",
      status: "missing",
      repairStatus: "pending",
    });

    const body = renderDailyTaskAudit(
      {
        window: { start: 0, end: 1, label: "2026-08-04 SGT" },
        counts: {
          success: 0,
          failed: 1,
          missing: 1,
          running: 0,
          runningTimeout: 0,
          skipped: 0,
        },
        items: [closedFailure, activeFailure],
      },
      [activeFailure],
      { repairDispatch: "queued repair run" },
    );

    expect(body).toContain("Repair: 1 candidates · queued repair run");
    expect(body).toContain("Closed: 1 previously reported");
    expect(body).toContain("active repair · missing");
    expect(body).not.toContain("closed repair · failed");
  });

  it("caps the rendered issue list and reports the hidden count", () => {
    const issues = Array.from({ length: 10 }, (_, index) =>
      taskAuditItem({
        taskId: `loop:issue-${index}`,
        name: `issue ${index}`,
        status: "failed",
        repairStatus: "pending",
      }),
    );

    const body = renderDailyTaskAudit(
      {
        window: { start: 0, end: 1, label: "2026-08-04 SGT" },
        counts: {
          success: 0,
          failed: 10,
          missing: 0,
          running: 0,
          runningTimeout: 0,
          skipped: 0,
        },
        items: issues,
      },
      issues,
    );

    expect(body).toContain("issue 0 · failed");
    expect(body).toContain("issue 7 · failed");
    expect(body).not.toContain("issue 8 · failed");
    expect(body).toContain("• …and 2 more");
  });

  it("builds an ok notification for an unknown empty window", () => {
    const notification = buildDailyTaskAuditNotification({
      summary: {
        window: null,
        counts: {
          success: 0,
          failed: 0,
          missing: 0,
          running: 0,
          runningTimeout: 0,
          skipped: 0,
        },
        items: [],
      },
      repairCandidates: [],
      channel: "telegram",
    });

    expect(notification).toMatchObject({
      channel: "telegram",
      level: "success",
      source: "daily-task-audit",
      title: "Daily task audit · unknown window",
    });
    expect(notification.body).toContain("No scheduled task records found.");
  });

  it("sends a previous-day success and failure summary and returns repair candidates", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-"));
    const ledger = new DailyTaskLedger();
    const okAt = Date.parse("2026-07-27T01:00:00Z");
    const failedAt = Date.parse("2026-07-27T02:00:00Z");
    ledger.expect({
      taskId: "loop:geo-backend:ok",
      source: "loop-engineering",
      name: "geo-backend architecture",
      scheduledAt: okAt,
    });
    ledger.finish("loop:geo-backend:ok", { endedAt: okAt + 1000, summary: "PR opened" });
    ledger.expect({
      taskId: "radar:daily:failed",
      source: "radar-monitor",
      name: "daily radar",
      scheduledAt: failedAt,
    });
    ledger.fail("radar:daily:failed", { endedAt: failedAt + 1000, error: "missing output" });

    const notify = vi.fn(async () => ({ status: "sent" as const, deliveries: [] }));
    const result = await runDailyTaskAudit({
      now: Date.parse("2026-07-28T02:00:00Z"),
      ledger,
      notify,
      channel: "lark",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "lark",
        level: "warning",
        title: "Daily task audit · 2026-07-27 SGT",
        body: expect.stringContaining("Counts: 1 success · 1 failed · 0 missing · 0 running"),
      }),
    );
    expect(result.repairCandidates.map((item) => item.taskId)).toEqual(["radar:daily:failed"]);
  });

  it("includes actively discovered scheduled tasks that never reported to the ledger", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-discovered-"));
    const ledger = new DailyTaskLedger();
    const notify = vi.fn(async () => ({ status: "sent" as const, deliveries: [] }));

    const result = await runDailyTaskAudit({
      now: Date.parse("2026-07-28T02:00:00Z"),
      ledger,
      notify,
      channel: "lark",
      discover: ({ window }) => [
        {
          taskId: `launchd:com.example.daily:${window.label}`,
          source: "launchd",
          name: "launchd com.example.daily",
          scheduledAt: window.start,
          status: "expected",
          updatedAt: window.start,
        },
      ],
    });

    expect(result.summary.counts.missing).toBe(1);
    expect(result.repairCandidates.map((item) => item.taskId)).toEqual([
      "launchd:com.example.daily:2026-07-27 SGT",
    ]);
    expect(ledger.listAll()).toEqual([
      expect.objectContaining({
        taskId: "launchd:com.example.daily:2026-07-27 SGT",
        status: "expected",
      }),
    ]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        body: expect.stringContaining("Counts: 0 success · 0 failed · 1 missing · 0 running"),
      }),
    );
  });

  it("reports non-timeout running tasks without dispatching them for repair", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-running-"));
    const ledger = new DailyTaskLedger();
    const scheduledAt = Date.parse("2026-07-27T15:00:00Z");
    ledger.expect({
      taskId: "batch:nightly:running",
      source: "batch-scheduler",
      name: "nightly batch",
      scheduledAt,
    });
    ledger.start("batch:nightly:running", scheduledAt + 1000);
    const notify = vi.fn(async () => ({ status: "sent" as const, deliveries: [] }));

    const result = await runDailyTaskAudit({
      now: Date.parse("2026-07-28T02:00:00Z"),
      ledger,
      notify,
      channel: "lark",
    });

    expect(result.summary.counts.running).toBe(1);
    expect(result.summary.counts.runningTimeout).toBe(0);
    expect(result.repairCandidates).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        body: expect.stringContaining("Counts: 0 success · 0 failed · 0 missing · 1 running"),
      }),
    );
    expect(notifiedBody(notify)).toContain("Status: ATTENTION");
    expect(notifiedBody(notify)).toContain("Repair: 0 candidates");
  });

  it("keeps superseded failures in the report but excludes them from repair candidates", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-fixed-"));
    const ledger = new DailyTaskLedger();
    const notifiedBodies: string[] = [];
    const notify = vi.fn(async (request: { body?: string }) => {
      if (request.body !== undefined) notifiedBodies.push(request.body);
      return { status: "sent" as const, deliveries: [] };
    });
    const scheduledAt = Date.parse("2026-07-27T07:00:00Z");

    const result = await runDailyTaskAudit({
      now: Date.parse("2026-07-28T02:00:00Z"),
      ledger,
      notify,
      channel: "lark",
      discover: () => [
        {
          taskId: `loop:geo-backend:${scheduledAt}`,
          source: "loop-engineering",
          name: "geo-backend architecture",
          scheduledAt,
          status: "failed",
          error: "loop supervisor run invalid-output: missing-final-marker",
          repairStatus: "fixed",
          summary: "Superseded by later successful loop run.",
          updatedAt: scheduledAt + 1000,
        },
      ],
    });

    expect(result.summary.counts.failed).toBe(1);
    expect(result.repairCandidates).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "success",
        body: expect.stringContaining("Counts: 0 success · 1 failed · 0 missing · 0 running"),
      }),
    );
    expect(notifiedBodies[0]).toContain("Status: OK");
    expect(notifiedBodies[0]).toContain("Repair: 0 candidates");
  });

  it("renders failure kinds for active repair candidates", async () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-kind-"));
    const ledger = new DailyTaskLedger();
    const scheduledAt = Date.parse("2026-07-27T02:00:00Z");
    ledger.expect({
      taskId: "loop:geo-frontend:bug-fix",
      source: "loop-engineering",
      name: "geo-frontend bug-fix",
      scheduledAt,
    });
    ledger.fail("loop:geo-frontend:bug-fix", {
      endedAt: scheduledAt + 1000,
      error: "supervisor-failed",
      summary: 'supervised system gate failed: CI check "verify" concluded FAILURE',
    });
    const notifiedBodies: string[] = [];
    const notify = vi.fn(async (request: { body?: string }) => {
      if (request.body !== undefined) notifiedBodies.push(request.body);
      return { status: "sent" as const, deliveries: [] };
    });

    const result = await runDailyTaskAudit({
      now: Date.parse("2026-07-28T02:00:00Z"),
      ledger,
      notify,
      channel: "lark",
    });

    expect(result.repairCandidates[0]).toMatchObject({
      taskId: "loop:geo-frontend:bug-fix",
      failureKind: "external-ci",
    });
    expect(notifiedBodies[0]).toContain("geo-frontend bug-fix · failed · external-ci");
    expect(notifiedBodies[0]).toContain("Status: ATTENTION");
    expect(notifiedBodies[0]).toContain("Repair: 1 candidates");
  });
});

function taskAuditItem(
  overrides: Partial<TaskAuditItem> & Pick<TaskAuditItem, "taskId" | "name" | "status">,
): TaskAuditItem {
  return {
    source: "loop-engineering",
    scheduledAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function notifiedBody(notify: ReturnType<typeof vi.fn>): string {
  const first = notify.mock.calls[0]?.[0] as { body?: string } | undefined;
  return first?.body ?? "";
}
