import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDailyTaskAudit } from "../../src/core/tasks/daily-audit.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
  else process.env.TCB_STATE_DIR = originalStateDir;
});

describe("runDailyTaskAudit", () => {
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
        title: "Daily scheduled task audit: 2026-07-27 SGT",
        body: expect.stringContaining("failed: 1"),
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
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warning",
        body: expect.stringContaining("missing: 1"),
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
        body: expect.stringContaining("running: 1"),
      }),
    );
    expect(notifiedBody(notify)).toContain("active-issues: 1");
    expect(notifiedBody(notify)).toContain("repair-candidates: 0");
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
        body: expect.stringContaining("failed: 1"),
      }),
    );
    expect(notifiedBodies[0]).toContain("repair: fixed");
    expect(notifiedBodies[0]).toContain("active-issues: 0");
    expect(notifiedBodies[0]).toContain("closed-failures: 1");
    expect(notifiedBodies[0]).toContain("Closed failures:");
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
    expect(notifiedBodies[0]).toContain("failure-kind: external-ci");
    expect(notifiedBodies[0]).toContain("active-issues: 1");
    expect(notifiedBodies[0]).toContain("repair-candidates: 1");
    expect(notifiedBodies[0]).toContain("kind=external-ci");
  });
});

function notifiedBody(notify: ReturnType<typeof vi.fn>): string {
  const first = notify.mock.calls[0]?.[0] as { body?: string } | undefined;
  return first?.body ?? "";
}
