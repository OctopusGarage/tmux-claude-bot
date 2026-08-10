import type { RepairCoordinator } from "./repair-coordinator.js";
import type { DailyTaskLedger } from "./task-ledger.js";

const STALE_DAILY_AUDIT_RUN_MS = 30 * 60_000;

/**
 * Reconcile every durable input to a Daily Task Audit before it discovers new
 * work. Keeping this ordering together prevents a stale ledger or repair lease
 * from being rediscovered and dispatched as a duplicate.
 */
export function reconcileDailyAuditRunState(input: {
  ledger: Pick<DailyTaskLedger, "reconcileStaleRunning" | "reconcileTerminalStatuses" | "listAll">;
  coordinator: Pick<
    RepairCoordinator,
    "reconcileExpiredLeases" | "reconcileDuplicateTaskIds" | "importPending" | "reconcileFromLedger"
  >;
  now: number;
  repoPath: string;
  reconcileRepairState: (input: { ledger: DailyTaskLedger; now: number }) => void;
}): number {
  const staleAudits = input.ledger.reconcileStaleRunning(input.now, {
    timeoutMs: STALE_DAILY_AUDIT_RUN_MS,
    sources: ["daily-audit"],
  });
  input.ledger.reconcileTerminalStatuses(input.now);
  input.coordinator.reconcileExpiredLeases(input.now);
  input.coordinator.reconcileDuplicateTaskIds(input.now);
  input.coordinator.importPending(input.ledger.listAll(), {
    projectId: "tmux-claude-bot",
    projectPath: input.repoPath,
    now: input.now,
  });
  input.reconcileRepairState({ ledger: input.ledger as DailyTaskLedger, now: input.now });
  input.coordinator.reconcileFromLedger(input.ledger.listAll(), input.now);
  return staleAudits;
}

/** Re-run the queue-normalization pass after project recovery changed durable state. */
export function reconcileDailyAuditRepairQueue(input: {
  ledger: Pick<DailyTaskLedger, "listAll">;
  coordinator: Pick<RepairCoordinator, "reconcileDuplicateTaskIds" | "reconcileFromLedger">;
  now: number;
}): void {
  input.coordinator.reconcileDuplicateTaskIds(input.now);
  input.coordinator.reconcileFromLedger(input.ledger.listAll(), input.now);
}
