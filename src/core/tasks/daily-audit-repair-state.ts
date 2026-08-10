import {
  listTerminalLoopSupervisorWorkOrders,
  listUnfinishedLoopSupervisorWorkOrders,
} from "../loop/supervisor-state.js";
import type { DailyTaskLedger } from "./task-ledger.js";

const STALE_REPAIR_STATUS_MS = 30 * 60_000;

export function reconcileDailyAuditRepairState(input: { ledger: DailyTaskLedger; now: number }): {
  reopened: number;
} {
  return { reopened: reopenStaleRepairStatuses(input.ledger, input.now) };
}

function reopenStaleRepairStatuses(ledger: DailyTaskLedger, now: number): number {
  const activeDelegatedTaskIds = new Set(
    listUnfinishedLoopSupervisorWorkOrders()
      .filter((record) => record.workOrder.task?.kind === "active-delegated-task")
      .map((record) => `autopilot:${record.workOrder.id}`),
  );
  const terminalDelegatedTaskIds = new Set(
    listTerminalLoopSupervisorWorkOrders()
      .filter((record) => record.workOrder.task?.kind === "active-delegated-task")
      .map((record) => `autopilot:${record.workOrder.id}`),
  );
  let reopened = 0;
  for (const record of ledger.listAll()) {
    if (record.repairStatus !== "running" || record.taskId.startsWith("daily-audit:self:"))
      continue;
    if (record.source === "autopilot-delegate" && activeDelegatedTaskIds.has(record.taskId))
      continue;
    const linkedWorkOrderIsTerminal =
      record.source === "autopilot-delegate" && terminalDelegatedTaskIds.has(record.taskId);
    if (!linkedWorkOrderIsTerminal && now - record.updatedAt < STALE_REPAIR_STATUS_MS) continue;
    ledger.markRepairStatus(record.taskId, {
      repairStatus: "pending",
      updatedAt: now,
      summary: appendRepairSummary(
        record.summary,
        "Reopened stale repair status after no active repair remained.",
      ),
    });
    reopened++;
  }
  return reopened;
}

function appendRepairSummary(current: string | undefined, next: string): string {
  return current === undefined || current.length === 0 ? next : `${current} ${next}`;
}
