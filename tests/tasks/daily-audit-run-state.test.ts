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
});
