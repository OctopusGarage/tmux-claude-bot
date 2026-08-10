import { describe, expect, it, vi } from "vitest";
import {
  reconcileDailyAuditRepairQueue,
  reconcileDailyAuditRunState,
} from "../../src/core/tasks/daily-audit-run-state.js";

describe("daily audit run state", () => {
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
    expect(coordinator.importPending).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ now: 100 }),
    );
    expect(repairState).toHaveBeenCalledWith({ ledger, now: 100 });
    expect(coordinator.reconcileDuplicateTaskIds).toHaveBeenCalledTimes(2);
    expect(coordinator.reconcileFromLedger).toHaveBeenCalledTimes(2);
  });
});
