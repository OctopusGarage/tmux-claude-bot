import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileDailyAuditRepairQueue,
  reconcileDailyAuditRunState,
  reconcilePendingLedgerFromTerminalRepairQueue,
} from "../../src/core/tasks/daily-audit-run-state.js";
import { runProjectRecoveryPass } from "../../src/core/tasks/project-recovery-service.js";
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

  it("preserves retry-wait ownership across repeated audit reconciliation passes", () => {
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:owned-repair",
      source: "loop-engineering",
      name: "tmux-claude-bot architecture",
      scheduledAt: 1_000,
    });
    ledger.fail("loop:owned-repair", { endedAt: 2_000, error: "dispatch-failed" });
    const store = new InMemoryRepairQueueStore();
    const coordinator = new RepairCoordinator(store);
    const record = coordinator.enqueue({
      projectId: "tmux-claude-bot",
      projectPath: "/repo/tmux-claude-bot",
      source: "project-recovery",
      taskFamily: "active-delegated-task",
      fingerprint: "invalid-final-summary",
      taskId: "loop:owned-repair",
      now: 3_000,
    });
    const owner = coordinator.releaseForRetry(record.id, 3_001);
    const ledgerBefore = ledger.listAll();

    for (const now of [4_000, 5_000]) {
      reconcileDailyAuditRunState({
        ledger,
        coordinator,
        now,
        repoPath: "/repo/tmux-claude-bot",
        reconcileRepairState: () => {},
      });
      expect(coordinator.list()).toEqual([owner]);
      reconcileDailyAuditRepairQueue({ ledger, coordinator, now });
      expect(coordinator.list()).toEqual([owner]);
      expect(ledger.listAll()).toEqual(ledgerBefore);
    }
  });

  it.each([3_999, 4_000, 5_000])(
    "preserves only a newer pending correction over fixed queue evidence at ledger time %s",
    (updatedAt) => {
      const ledger = new DailyTaskLedger();
      ledger.expect({
        taskId: "original",
        source: "loop-engineering",
        name: "suite bug-fix",
        scheduledAt: 1_000,
      });
      ledger.fail("original", { endedAt: 2_000, error: "dispatch-timeout" });
      const coordinator = new RepairCoordinator();
      const queue = coordinator.enqueue({
        projectId: "suite",
        projectPath: "/repo/suite",
        source: "project-recovery",
        taskFamily: "suite bug-fix",
        fingerprint: "unknown",
        taskId: "original",
        now: 3_000,
      });
      coordinator.markTerminal(queue.id, "fixed", 4_000);
      ledger.markRepairStatus("original", {
        repairStatus: "pending",
        updatedAt,
        summary: "Verified repair correction",
      });
      const before = ledger.listAll();
      for (const now of [6_000, 7_000]) {
        reconcilePendingLedgerFromTerminalRepairQueue({
          ledger: new DailyTaskLedger(),
          coordinator: new RepairCoordinator(),
          now,
        });
      }
      if (updatedAt > 4_000) expect(ledger.listAll()).toEqual(before);
      else expect(ledger.listAll()[0]?.repairStatus).toBe("fixed");
      expect(coordinator.list()[0]).toMatchObject({
        status: "fixed",
        attempt: 0,
        updatedAt: 4_000,
      });
    },
  );

  it("keeps a corrected original eligible for guarded recovery across audit ticks", async () => {
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "loop:suite:bug-fix:1000",
      source: "loop-engineering",
      name: "suite bug-fix",
      scheduledAt: 1_000,
    });
    const coordinator = new RepairCoordinator();
    const queue = coordinator.enqueue({
      projectId: "suite",
      projectPath: "/repo/suite",
      source: "project-recovery",
      taskFamily: "suite bug-fix",
      fingerprint: "missing-run-record",
      taskId: "loop:suite:bug-fix:1000",
      now: 3_000,
    });
    coordinator.releaseForRetry(queue.id, 3_001);
    coordinator.markTerminal(queue.id, "fixed", 4_000);
    ledger.markRepairStatus("loop:suite:bug-fix:1000", {
      repairStatus: "pending",
      updatedAt: 5_000,
    });
    const dispatch = vi.fn(async () => ({
      status: "blocked" as const,
      detail: "automation admission deferred: active worker lease",
      retryAt: 8_000,
    }));
    for (const now of [6_000, 7_000]) {
      reconcileDailyAuditRunState({
        ledger,
        coordinator: new RepairCoordinator(),
        now,
        repoPath: "/repo/bot",
        reconcileRepairState: () => {},
      });
      await runProjectRecoveryPass({
        now,
        records: ledger
          .listAll()
          .flatMap((record) =>
            record.repairStatus === "pending"
              ? [{ ...record, repairStatus: "pending" as const }]
              : [],
          ),
        coordinator,
        config: {
          projects: [{ id: "suite", name: "Suite", path: "/repo/suite" }],
          repositories: [],
          workspaces: [],
        },
        updateRepairStatus: (taskId, repairStatus, summary) =>
          ledger.markRepairStatus(taskId, { repairStatus, summary, updatedAt: now }),
        dispatch,
        canonicalize: (path) => path,
      });
      expect(ledger.listAll()).toEqual([expect.objectContaining({ repairStatus: "pending" })]);
      expect(
        coordinator.list().some((record) => record.status === "pending" && record.attempt === 1),
      ).toBe(true);
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses the newest terminal evidence for an exact task across duplicate queues", () => {
    const ledger = new DailyTaskLedger();
    ledger.expect({
      taskId: "original",
      source: "loop-engineering",
      name: "suite bug-fix",
      scheduledAt: 1_000,
    });
    ledger.fail("original", { endedAt: 2_000, error: "dispatch-timeout" });
    const store = new InMemoryRepairQueueStore();
    const coordinator = new RepairCoordinator(store);
    const newest = coordinator.enqueue({
      projectId: "suite",
      projectPath: "/repo/suite",
      source: "project-recovery",
      taskFamily: "suite bug-fix",
      fingerprint: "new",
      taskId: "original",
      now: 3_000,
    });
    coordinator.markTerminal(newest.id, "fixed", 8_000);
    store.set("older", {
      ...newest,
      id: "older",
      createdAt: 4_000,
      updatedAt: 4_500,
      status: "blocked",
    });
    ledger.markRepairStatus("original", { repairStatus: "pending", updatedAt: 5_000 });
    reconcilePendingLedgerFromTerminalRepairQueue({ ledger, coordinator, now: 9_000 });
    expect(ledger.listAll()[0]?.repairStatus).toBe("fixed");
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
