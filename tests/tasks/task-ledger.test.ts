import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyTaskFailure,
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

  it("normalizes successful and skipped tasks to the not-needed repair terminal", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-terminal-"));
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:geo:success",
      source: "loop-engineering",
      name: "geo architecture",
      scheduledAt: 1,
    });
    ledger.finish("loop:geo:success", { endedAt: 2 });
    ledger.markRepairStatus("loop:geo:success", {
      repairStatus: "blocked",
      updatedAt: 3,
    });

    expect(ledger.reconcileTerminalStatuses(4)).toBe(1);
    expect(ledger.listAll()[0]).toMatchObject({
      status: "success",
      repairStatus: "not-needed",
    });
  });

  it("classifies active automation admission conflicts as system gates", () => {
    expect(
      classifyTaskFailure(
        "project already has active automation: active-delegated-task 1787932899837-tmux-claude-bot-active-delegate (in-flight)",
        "System self-heal agent sweep deferred before WorkOrder creation",
      ),
    ).toBe("system-gate");
  });

  it("clears stale failure fields when a task later succeeds or skips", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-clear-failure-"));
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:alcove:harness-auto",
      source: "loop-engineering",
      name: "alcove harness-auto",
      scheduledAt: 1,
    });
    ledger.fail("loop:alcove:harness-auto", {
      endedAt: 2,
      error: "supervisor-failed",
      summary: "supervised system gate failed",
    });
    ledger.finish("loop:alcove:harness-auto", { endedAt: 3, summary: "verified no-delta" });

    expect(ledger.listAll()[0]).toMatchObject({
      status: "success",
      repairStatus: "not-needed",
      summary: "verified no-delta",
    });
    expect(ledger.listAll()[0]?.error).toBeUndefined();
    expect(ledger.listAll()[0]?.failureKind).toBeUndefined();

    ledger.expect({
      taskId: "system-self-heal:agent-sweep",
      source: "system-self-heal",
      name: "System self-heal agent sweep",
      scheduledAt: 4,
    });
    ledger.fail("system-self-heal:agent-sweep", {
      endedAt: 5,
      error: "autonomous-heavy-active-lease",
    });
    ledger.skip("system-self-heal:agent-sweep", { endedAt: 6, summary: "deferred" });

    expect(ledger.listAll()[1]).toMatchObject({
      status: "skipped",
      repairStatus: "not-needed",
      summary: "deferred",
    });
    expect(ledger.listAll()[1]?.error).toBeUndefined();
    expect(ledger.listAll()[1]?.failureKind).toBeUndefined();
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

  it("reconciles stale running records without touching live records or other sources", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-stale-running-"));
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "daily-audit:stale",
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: 1,
    });
    ledger.start("daily-audit:stale", 1_000);
    ledger.expect({
      taskId: "daily-audit:live",
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: 2,
    });
    ledger.start("daily-audit:live", 9_500);
    ledger.expect({
      taskId: "loop:live",
      source: "loop-engineering",
      name: "live loop",
      scheduledAt: 3,
    });
    ledger.start("loop:live", 1_000);

    expect(
      ledger.reconcileStaleRunning(10_000, { timeoutMs: 5_000, sources: ["daily-audit"] }),
    ).toBe(1);
    expect(ledger.listAll()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: "daily-audit:stale",
          status: "running-timeout",
          repairStatus: "pending",
        }),
        expect.objectContaining({ taskId: "daily-audit:live", status: "running" }),
        expect.objectContaining({ taskId: "loop:live", status: "running" }),
      ]),
    );
  });

  it("classifies common loop task failure causes", () => {
    expect(classifyTaskFailure("invalid-output", "missing-final-marker")).toBe(
      "invalid-final-summary",
    );
    expect(classifyTaskFailure("supervisor-failed", 'CI check "verify" concluded FAILURE')).toBe(
      "external-ci",
    );
    expect(classifyTaskFailure("blocked", "worktree is dirty before sync")).toBe("dirty-worktree");
    expect(
      classifyTaskFailure(
        "automation admission deferred: interactive-agent-busy",
        "System self-heal agent sweep deferred before WorkOrder creation",
      ),
    ).toBe("system-gate");
    expect(
      classifyTaskFailure("automation admission deferred: autonomous-heavy-active-lease", ""),
    ).toBe("system-gate");
    expect(classifyTaskFailure("dispatch-failed", "Codex did not become ready in time")).toBe(
      "agent-timeout",
    );
    expect(classifyTaskFailure("notification failed", "TLS handshake timeout")).toBe(
      "external-service",
    );
    expect(
      classifyTaskFailure(
        "dispatch-failed",
        "Selected model is at capacity. Please try a different model.",
      ),
    ).toBe("agent-capacity");
  });

  it("marks earlier unresolved same-job failures as superseded by later success", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-supersede-"));
    const ledger = new DailyTaskLedger();
    const firstAt = Date.parse("2026-07-27T01:00:00Z");
    const secondAt = Date.parse("2026-07-27T02:00:00Z");

    ledger.expect({
      taskId: "loop:geo-backend:pull-request-review:first",
      source: "loop-engineering",
      name: "geo-backend pull-request-review",
      scheduledAt: firstAt,
    });
    ledger.fail("loop:geo-backend:pull-request-review:first", {
      endedAt: firstAt + 1000,
      error: "supervisor-failed",
      summary: 'supervised system gate failed: PR lookup failed for branch "loop/pr-review"',
    });
    ledger.expect({
      taskId: "loop:geo-backend:pull-request-review:second",
      source: "loop-engineering",
      name: "geo-backend pull-request-review",
      scheduledAt: secondAt,
    });
    ledger.finish("loop:geo-backend:pull-request-review:second", {
      endedAt: secondAt + 1000,
      summary: "completed no-op review",
    });

    expect(
      ledger
        .listForWindow(singaporeDayWindow("2026-07-27"))
        .map((record) => [record.taskId, record.status, record.repairStatus, record.summary]),
    ).toEqual([
      [
        "loop:geo-backend:pull-request-review:first",
        "failed",
        "superseded",
        'supervised system gate failed: PR lookup failed for branch "loop/pr-review"; Superseded by later successful task loop:geo-backend:pull-request-review:second.',
      ],
      [
        "loop:geo-backend:pull-request-review:second",
        "success",
        "not-needed",
        "completed no-op review",
      ],
    ]);
  });

  it("reconciles superseded failures already present in the ledger", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-reconcile-"));
    const ledger = new DailyTaskLedger();
    const firstAt = Date.parse("2026-07-27T01:00:00Z");
    const secondAt = Date.parse("2026-07-27T02:00:00Z");

    ledger.expect({
      taskId: "loop:geo-backend:pull-request-review:first",
      source: "loop-engineering",
      name: "geo-backend pull-request-review",
      scheduledAt: firstAt,
    });
    ledger.fail("loop:geo-backend:pull-request-review:first", {
      endedAt: firstAt + 1000,
      error: "supervisor-failed",
    });
    ledger.expect({
      taskId: "loop:geo-backend:pull-request-review:second",
      source: "loop-engineering",
      name: "geo-backend pull-request-review",
      scheduledAt: secondAt,
    });
    ledger.finish("loop:geo-backend:pull-request-review:second", {
      endedAt: secondAt + 1000,
    });
    ledger.markRepairStatus("loop:geo-backend:pull-request-review:first", {
      repairStatus: "pending",
      updatedAt: secondAt + 2000,
      summary: "legacy pending failure",
    });

    expect(ledger.reconcileSupersededFailures()).toBe(1);
    expect(ledger.listForWindow(singaporeDayWindow("2026-07-27"))[0]).toMatchObject({
      taskId: "loop:geo-backend:pull-request-review:first",
      repairStatus: "superseded",
      summary:
        "legacy pending failure; Superseded by later successful task loop:geo-backend:pull-request-review:second.",
    });
  });

  it("prunes only terminal task history after the bounded retention window", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-prune-"));
    const ledger = new DailyTaskLedger();
    const eightDays = 8 * 24 * 60 * 60 * 1000;

    ledger.expect({
      taskId: "loop:old-success",
      source: "loop-engineering",
      name: "old success",
      scheduledAt: 1_000,
    });
    ledger.finish("loop:old-success", { endedAt: 2_000 });
    ledger.expect({
      taskId: "loop:old-missing",
      source: "loop-engineering",
      name: "old missing",
      scheduledAt: 3_000,
    });
    ledger.reconcileExpectedMissing(eightDays);
    ledger.expect({
      taskId: "loop:recent-success",
      source: "loop-engineering",
      name: "recent success",
      scheduledAt: eightDays,
    });
    ledger.finish("loop:recent-success", { endedAt: eightDays });

    expect(ledger.pruneTerminal(eightDays + 2_000)).toBe(1);
    expect(ledger.listAll().map((record) => record.taskId)).toEqual([
      "loop:old-missing",
      "loop:recent-success",
    ]);
  });

  it("only supersedes an unresolved failure once when multiple later successes exist", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-reconcile-once-"));
    const ledger = new DailyTaskLedger();
    const firstAt = Date.parse("2026-07-27T01:00:00Z");
    const secondAt = Date.parse("2026-07-27T02:00:00Z");
    const thirdAt = Date.parse("2026-07-27T03:00:00Z");

    ledger.expect({
      taskId: "loop:geo-backend:bug-fix:first",
      source: "loop-engineering",
      name: "geo-backend bug-fix",
      scheduledAt: firstAt,
    });
    ledger.fail("loop:geo-backend:bug-fix:first", {
      endedAt: firstAt + 1000,
      error: "supervisor-failed",
      summary: "legacy pending failure",
    });
    for (const [taskId, scheduledAt] of [
      ["loop:geo-backend:bug-fix:second", secondAt],
      ["loop:geo-backend:bug-fix:third", thirdAt],
    ] as const) {
      ledger.expect({
        taskId,
        source: "loop-engineering",
        name: "geo-backend bug-fix",
        scheduledAt,
      });
      ledger.finish(taskId, { endedAt: scheduledAt + 1000 });
    }
    ledger.markRepairStatus("loop:geo-backend:bug-fix:first", {
      repairStatus: "pending",
      updatedAt: thirdAt + 2000,
      summary: "legacy pending failure",
    });

    expect(ledger.reconcileSupersededFailures()).toBe(1);
    expect(ledger.listAll()[0]).toMatchObject({
      repairStatus: "superseded",
      summary:
        "legacy pending failure; Superseded by later successful task loop:geo-backend:bug-fix:second.",
    });
  });

  it("keeps non-retryable project recovery closures closed across later deferrals", () => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-task-ledger-non-retryable-"));
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:knowledge-engine:active-delegated-task:1786972706589",
      source: "loop-engineering",
      name: "knowledge-engine active-delegated-task",
      scheduledAt: 1_000,
    });
    ledger.fail("loop:knowledge-engine:active-delegated-task:1786972706589", {
      endedAt: 1_500,
      error: "blocked",
      summary: "active delegation ended with blocked",
    });
    ledger.markRepairStatus("loop:knowledge-engine:active-delegated-task:1786972706589", {
      repairStatus: "blocked",
      updatedAt: 2_000,
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
    });

    ledger.markRepairStatus("loop:knowledge-engine:active-delegated-task:1786972706589", {
      repairStatus: "pending",
      updatedAt: 2_500,
      summary: "Recovery dispatch deferred: automation admission deferred: capacity-exhausted",
    });
    ledger.fail("loop:knowledge-engine:active-delegated-task:1786972706589", {
      endedAt: 3_000,
      error: "blocked",
      summary: "Recovery dispatch deferred: automation admission deferred: capacity-exhausted",
    });

    expect(ledger.listAll()[0]).toMatchObject({
      repairStatus: "blocked",
      summary:
        "Closed from the authoritative accepted blocked project recovery; no retryable project repair remains.",
      updatedAt: 3_000,
    });
  });
});
