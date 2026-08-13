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
});
