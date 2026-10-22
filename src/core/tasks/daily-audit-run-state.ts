import type { RepairCoordinator } from "./repair-coordinator.js";
import type { DailyTaskLedger, ScheduledTaskRepairStatus } from "./task-ledger.js";

const STALE_DAILY_AUDIT_RUN_MS = 30 * 60_000;

/**
 * Reconcile every durable input to a Daily Task Audit before it discovers new
 * work. Keeping this ordering together prevents a stale ledger or repair lease
 * from being rediscovered and dispatched as a duplicate.
 */
export function reconcileDailyAuditRunState(input: {
  ledger: Pick<
    DailyTaskLedger,
    "reconcileStaleRunning" | "reconcileExpectedMissing" | "reconcileTerminalStatuses" | "listAll"
  >;
  coordinator: Pick<
    RepairCoordinator,
    | "reconcileExpiredLeases"
    | "reconcileDuplicateTaskIds"
    | "importPending"
    | "reconcileFromLedger"
    | "list"
  >;
  now: number;
  repoPath: string;
  reconcileRepairState: (input: { ledger: DailyTaskLedger; now: number }) => void;
}): number {
  const staleAudits = input.ledger.reconcileStaleRunning(input.now, {
    timeoutMs: STALE_DAILY_AUDIT_RUN_MS,
    sources: ["daily-audit"],
  });
  input.ledger.reconcileExpectedMissing(input.now);
  input.ledger.reconcileTerminalStatuses(input.now);
  input.coordinator.reconcileExpiredLeases(input.now);
  input.coordinator.reconcileDuplicateTaskIds(input.now);
  input.reconcileRepairState({ ledger: input.ledger as DailyTaskLedger, now: input.now });
  reconcileStaleDailyAuditSelfChecks({
    ledger: input.ledger as DailyTaskLedger,
    now: input.now,
  });
  reconcilePendingLedgerFromTerminalRepairQueue({
    ledger: input.ledger as DailyTaskLedger,
    coordinator: input.coordinator,
    now: input.now,
  });
  input.coordinator.importPending(input.ledger.listAll(), {
    projectId: "tmux-claude-bot",
    projectPath: input.repoPath,
    now: input.now,
  });
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

export function reconcilePendingLedgerFromTerminalRepairQueue(input: {
  ledger: Pick<DailyTaskLedger, "listAll" | "markRepairStatus">;
  coordinator: Pick<RepairCoordinator, "list">;
  now: number;
}): number {
  const openTaskIds = new Set<string>();
  const terminalByTaskId = new Map<string, ScheduledTaskRepairStatus>();
  for (const record of input.coordinator.list()) {
    if (isTerminalRepairStatus(record.status)) {
      const repairStatus = ledgerRepairStatusForQueueStatus(record.status);
      for (const taskId of record.linkedTaskIds) terminalByTaskId.set(taskId, repairStatus);
      continue;
    }
    for (const taskId of record.linkedTaskIds) openTaskIds.add(taskId);
  }

  let updated = 0;
  for (const record of input.ledger.listAll()) {
    if (record.repairStatus !== "pending" && record.repairStatus !== "running") continue;
    if (openTaskIds.has(record.taskId)) continue;
    const repairStatus = terminalByTaskId.get(record.taskId);
    if (repairStatus === undefined) continue;
    input.ledger.markRepairStatus(record.taskId, {
      repairStatus,
      updatedAt: input.now,
      summary: appendSummary(
        record.summary,
        `Synchronized from terminal repair queue state (${repairStatus}).`,
      ),
    });
    updated++;
  }
  return updated;
}

export function reconcileStaleDailyAuditSelfChecks(input: {
  ledger: Pick<DailyTaskLedger, "listAll" | "markRepairStatus">;
  now: number;
}): number {
  const records = input.ledger.listAll();
  const byTaskId = new Map(records.map((record) => [record.taskId, record]));
  const recoveredAuditTimes = records
    .filter((record) => record.source === "daily-audit")
    .filter((record) => !record.taskId.startsWith("daily-audit:self:"))
    .filter((record) => record.status === "success")
    .filter((record) => /\bnotification=(sent|suppressed)\b/.test(record.summary ?? ""))
    .map((record) => record.scheduledAt);
  let updated = 0;
  for (const record of records) {
    if (!record.taskId.startsWith("daily-audit:self:")) continue;
    if (record.repairStatus !== "pending") continue;
    const auditedScheduledAt = Number(record.taskId.slice("daily-audit:self:".length));
    if (!Number.isFinite(auditedScheduledAt)) continue;
    const auditedRecord = byTaskId.get(`daily-audit:${auditedScheduledAt}`);
    const auditedRepairStatus = auditedRecord?.repairStatus;
    const auditedClosedByRecovery =
      auditedRepairStatus !== undefined &&
      ["fixed", "superseded", "not-reproducible"].includes(auditedRepairStatus);
    const laterAuditNotificationRecovered = recoveredAuditTimes.some(
      (scheduledAt) => scheduledAt > auditedScheduledAt,
    );
    if (!auditedClosedByRecovery && !laterAuditNotificationRecovered) continue;
    input.ledger.markRepairStatus(record.taskId, {
      repairStatus: "not-needed",
      updatedAt: input.now,
      summary: appendSummary(
        record.summary,
        "Closed stale Daily Task Audit self-check after a later successful Daily Task Audit notification recovered.",
      ),
    });
    updated++;
  }
  return updated;
}

function isTerminalRepairStatus(status: string): boolean {
  return ["fixed", "blocked", "not-reproducible", "superseded", "dead-letter"].includes(status);
}

function ledgerRepairStatusForQueueStatus(status: string): ScheduledTaskRepairStatus {
  if (status === "fixed") return "fixed";
  if (status === "not-reproducible") return "not-reproducible";
  if (status === "superseded") return "superseded";
  return "blocked";
}

function appendSummary(current: string | undefined, addition: string): string {
  if (current === undefined || current.trim().length === 0) return addition;
  if (current.includes(addition)) return current;
  return `${current}; ${addition}`;
}
