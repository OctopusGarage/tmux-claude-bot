import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileDailyAuditRepairQueue,
  reconcileDailyAuditRunState,
} from "../../src/core/tasks/daily-audit-run-state.js";
import {
  InMemoryRepairQueueStore,
  RepairCoordinator,
} from "../../src/core/tasks/repair-coordinator.js";
import { DailyTaskLedger } from "../../src/core/tasks/task-ledger.js";

const originalStateDir = process.env.TCB_STATE_DIR;

describe("daily audit run state", () => {
  beforeEach(() => {
    process.env.TCB_STATE_DIR = mkdtempSync(join(tmpdir(), "tcb-daily-audit-run-state-"));
  });

  afterEach(() => {
    const stateDir = process.env.TCB_STATE_DIR;
    if (stateDir !== undefined) rmSync(stateDir, { recursive: true, force: true });
    if (originalStateDir === undefined) delete process.env.TCB_STATE_DIR;
    else process.env.TCB_STATE_DIR = originalStateDir;
  });

  it("reconciles durable ledger and repair state before task discovery", () => {
    const ledger = {
      reconcileStaleRunning: vi.fn(() => 1),
      reconcileExpectedMissing: vi.fn(() => 0),
      reconcileTerminalStatuses: vi.fn(),
      listAll: vi.fn(() => []),
    };
    const coordinator = {
      reconcileExpiredLeases: vi.fn(),
      reconcileDuplicateTaskIds: vi.fn(),
      importPending: vi.fn(),
      reconcileFromLedger: vi.fn(),
      list: vi.fn(() => []),
    };
    const repairState = vi.fn();

    reconcileDailyAuditRunState({
      ledger: ledger as never,
      coordinator: coordinator as never,
      now: 100,
      repoPath: "/repo",
      reconcileRepairState: repairState,
    });
    reconcileDailyAuditRepairQueue({
      ledger: ledger as never,
      coordinator: coordinator as never,
      now: 100,
    });

    expect(ledger.reconcileStaleRunning).toHaveBeenCalledWith(100, expect.any(Object));
    expect(ledger.reconcileExpectedMissing).toHaveBeenCalledWith(100);
    expect(ledger.reconcileExpectedMissing.mock.invocationCallOrder[0]).toBeLessThan(
      coordinator.importPending.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(repairState).toHaveBeenCalledWith({ ledger, now: 100 });
    expect(repairState.mock.invocationCallOrder[0]).toBeLessThan(
      coordinator.importPending.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(coordinator.importPending).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ now: 100 }),
    );
    expect(coordinator.reconcileDuplicateTaskIds).toHaveBeenCalledTimes(2);
    expect(coordinator.reconcileFromLedger).toHaveBeenCalledTimes(2);
  });

  it("imports a repair record reopened during the same reconciliation pass", () => {
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:stale-repair",
      source: "loop-engineering",
      name: "tmux-claude-bot loop repair",
      scheduledAt: 1_000,
    });
    ledger.fail("loop:stale-repair", { endedAt: 2_000, error: "invalid final summary" });
    ledger.markRepairStatus("loop:stale-repair", {
      repairStatus: "running",
      updatedAt: 3_000,
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());

    reconcileDailyAuditRunState({
      ledger,
      coordinator,
      now: 60 * 60_000,
      repoPath: "/repo/tmux-claude-bot",
      reconcileRepairState: ({ ledger: currentLedger, now }) => {
        currentLedger.markRepairStatus("loop:stale-repair", {
          repairStatus: "pending",
          updatedAt: now,
        });
      },
    });

    expect(coordinator.list()).toContainEqual(
      expect.objectContaining({
        projectId: "tmux-claude-bot",
        source: "loop-engineering",
        linkedTaskIds: ["loop:stale-repair"],
        status: "pending",
      }),
    );
  });

  it("terminalizes pending ledger repairs when no open repair queue owner remains", () => {
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:english-pilot:active-delegated-task:1",
      source: "loop-engineering",
      name: "english-pilot active-delegated-task",
      scheduledAt: 1_000,
    });
    ledger.fail("loop:english-pilot:active-delegated-task:1", {
      endedAt: 2_000,
      error: "dispatch-timeout",
      summary:
        "Recovery dispatch deferred: automation admission deferred: critical resource pressure",
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    const record = coordinator.enqueue({
      projectId: "english-pilot",
      projectPath: "/repo/english-pilot",
      source: "project-recovery",
      taskFamily: "english-pilot active-delegated-task",
      fingerprint: "agent-timeout",
      taskId: "loop:english-pilot:active-delegated-task:1",
      now: 3_000,
    });
    coordinator.markTerminal(record.id, "blocked", 4_000);

    reconcileDailyAuditRunState({
      ledger,
      coordinator,
      now: 60 * 60_000,
      repoPath: "/repo/tmux-claude-bot",
      reconcileRepairState: () => {},
    });

    expect(
      ledger
        .listAll()
        .find((entry) => entry.taskId === "loop:english-pilot:active-delegated-task:1"),
    ).toMatchObject({
      repairStatus: "blocked",
      summary: expect.stringContaining("Synchronized from terminal repair queue state"),
    });
    expect(
      coordinator
        .list()
        .filter(
          (entry) =>
            !["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(
              entry.status,
            ),
        ),
    ).toEqual([]);
  });

  it("closes stale self-check repairs after a later audit notification succeeds", () => {
    const previousAuditAt = Date.parse("2026-08-30T04:36:24.249Z");
    const recoveredAuditAt = Date.parse("2026-08-30T05:41:24.947Z");
    const now = Date.parse("2026-08-30T16:15:07.903Z");
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: `daily-audit:${previousAuditAt}`,
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: previousAuditAt,
    });
    ledger.fail(`daily-audit:${previousAuditAt}`, {
      endedAt: previousAuditAt,
      error: "notification failed: telegram: no sender registered; lark: no sender registered",
      summary: "failures=4 repair-dispatch=deferred notification=failed",
    });
    ledger.markRepairStatus(`daily-audit:${previousAuditAt}`, {
      repairStatus: "superseded",
      updatedAt: previousAuditAt + 1,
      summary: `Superseded by later successful task daily-audit:${recoveredAuditAt}.`,
    });
    ledger.expect({
      taskId: `daily-audit:self:${previousAuditAt}`,
      source: "daily-audit",
      name: "Daily task audit self-check",
      scheduledAt: previousAuditAt,
    });
    ledger.fail(`daily-audit:self:${previousAuditAt}`, {
      endedAt: now,
      error:
        "previous audit status=failed error=notification failed: telegram: no sender registered; lark: no sender registered",
      summary:
        "Daily Task Audit self-check found previous audit issue: previous audit status=failed error=notification failed: telegram: no sender registered; lark: no sender registered",
    });
    ledger.expect({
      taskId: `daily-audit:${recoveredAuditAt}`,
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: recoveredAuditAt,
    });
    ledger.finish(`daily-audit:${recoveredAuditAt}`, {
      endedAt: recoveredAuditAt,
      summary: "failures=0 repair-dispatch=not-needed notification=sent",
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "Daily task audit self-check",
      fingerprint: "notification",
      taskId: `daily-audit:self:${previousAuditAt}`,
      now,
    });

    reconcileDailyAuditRunState({
      ledger,
      coordinator,
      now,
      repoPath: "/repo/tmux-claude-bot",
      reconcileRepairState: () => {},
    });

    expect(
      ledger.listAll().find((entry) => entry.taskId === `daily-audit:self:${previousAuditAt}`),
    ).toMatchObject({
      repairStatus: "not-needed",
      summary: expect.stringContaining("later successful Daily Task Audit"),
    });
    expect(coordinator.list()).toContainEqual(
      expect.objectContaining({
        status: "fixed",
        linkedTaskIds: [`daily-audit:self:${previousAuditAt}`],
      }),
    );
  });

  it("keeps a pending self-check when a partial audit notification has not recovered", () => {
    const previousAuditAt = Date.parse("2026-08-30T05:41:24.947Z");
    const now = Date.parse("2026-08-30T16:15:07.903Z");
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: `daily-audit:${previousAuditAt}`,
      source: "daily-audit",
      name: "Daily scheduled task audit",
      scheduledAt: previousAuditAt,
    });
    ledger.finish(`daily-audit:${previousAuditAt}`, {
      endedAt: previousAuditAt,
      summary: "failures=0 repair-dispatch=not-needed notification=partial",
    });
    ledger.expect({
      taskId: `daily-audit:self:${previousAuditAt}`,
      source: "daily-audit",
      name: "Daily task audit self-check",
      scheduledAt: previousAuditAt,
    });
    ledger.fail(`daily-audit:self:${previousAuditAt}`, {
      endedAt: now,
      error: "previous audit notification=partial",
      summary:
        "Daily Task Audit self-check found previous audit issue: previous audit notification=partial",
    });
    const coordinator = new RepairCoordinator(new InMemoryRepairQueueStore());
    coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "daily-audit",
      taskFamily: "Daily task audit self-check",
      fingerprint: "notification",
      taskId: `daily-audit:self:${previousAuditAt}`,
      now,
    });

    reconcileDailyAuditRunState({
      ledger,
      coordinator,
      now,
      repoPath: "/repo/tmux-claude-bot",
      reconcileRepairState: () => {},
    });

    expect(
      ledger.listAll().find((entry) => entry.taskId === `daily-audit:self:${previousAuditAt}`),
    ).toMatchObject({
      repairStatus: "pending",
    });
    expect(coordinator.list()).toContainEqual(
      expect.objectContaining({
        status: "pending",
        linkedTaskIds: [`daily-audit:self:${previousAuditAt}`],
      }),
    );
  });
});
