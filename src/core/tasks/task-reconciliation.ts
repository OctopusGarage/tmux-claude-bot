import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listRecoverableFinalSummaryLoopSupervisorWorkOrders,
  listTerminalLoopSupervisorWorkOrders,
} from "../loop/supervisor-state.js";
import { parseSupervisorFinalSummaryFile } from "../loop/work-order.js";
import { RepairCoordinator } from "./repair-coordinator.js";
import { DailyTaskLedger } from "./task-ledger.js";

export type AutopilotDelegatedTaskReconciliation = {
  checked: number;
  finished: number;
  failed: number;
  cleaned: number;
};

export async function reconcileAutopilotDelegatedTasks(
  input: {
    now?: number;
    ledger?: DailyTaskLedger;
    cleanupWorkerSession?: (session: string) => Promise<void> | void;
  } = {},
): Promise<AutopilotDelegatedTaskReconciliation> {
  const ledger = input.ledger ?? new DailyTaskLedger();
  const coordinator = new RepairCoordinator();
  const terminalByRunId = new Map(
    [
      ...listTerminalLoopSupervisorWorkOrders(),
      ...listRecoverableFinalSummaryLoopSupervisorWorkOrders(),
    ].map((record) => [record.workOrder.id, record]),
  );
  const result: AutopilotDelegatedTaskReconciliation = {
    checked: 0,
    finished: 0,
    failed: 0,
    cleaned: 0,
  };
  const now = input.now ?? Date.now();

  for (const task of ledger.listAll()) {
    if (task.source !== "autopilot-delegate" || task.status !== "running") continue;
    const runId = task.taskId.startsWith("autopilot:")
      ? task.taskId.slice("autopilot:".length)
      : task.taskId;
    const terminal = terminalByRunId.get(runId);
    if (terminal === undefined) continue;
    result.checked += 1;

    const summary = parseSupervisorFinalSummaryFile(terminal.workOrder);
    const gatePath = join(terminal.runDir, "system-gate.json");
    const gate = readAcceptedSystemGate(
      gatePath,
      terminal.workOrder.id,
      terminal.workOrder.projectId,
    );
    const recoveredSuccessfully = summary.ok && summary.summary.status === "completed" && gate.ok;
    if (recoveredSuccessfully) {
      ledger.finish(task.taskId, {
        endedAt: now,
        summary: "Reconciled from terminal supervisor artifacts.",
        reportPath: terminal.runDir,
      });
      reconcileDelegatedRepairQueue({
        coordinator,
        ledger,
        delegatedTaskId: task.taskId,
        now,
        succeeded: true,
      });
      result.finished += 1;
    } else {
      const reason = !summary.ok
        ? `invalid or missing final summary (${summary.reason})`
        : !gate.ok
          ? gate.reason
          : `terminal summary status=${summary.summary.status}`;
      ledger.fail(task.taskId, {
        endedAt: now,
        error: `Autopilot delegated task reconciliation failed: ${reason}`,
        summary: "Reconciled terminal supervisor artifacts and found an incomplete closure.",
        reportPath: terminal.runDir,
      });
      reconcileDelegatedRepairQueue({
        coordinator,
        ledger,
        delegatedTaskId: task.taskId,
        now,
        succeeded: false,
      });
      result.failed += 1;
    }

    if (input.cleanupWorkerSession !== undefined && terminal.workOrder.workerSession) {
      try {
        await input.cleanupWorkerSession(terminal.workOrder.workerSession);
        result.cleaned += 1;
      } catch {
        // Ledger closure remains durable; the next guardian tick can retry cleanup.
      }
    }
  }

  return result;
}

function readAcceptedSystemGate(
  path: string,
  workOrderId: string,
  projectId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: `missing system gate (${path})` };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: `invalid system gate (${path})` };
    }
    const gate = value as Partial<{
      accepted: boolean;
      resultStatus: string;
      workOrderId: string;
      projectId: string;
    }>;
    if (
      gate.accepted !== true ||
      gate.resultStatus !== "completed" ||
      gate.workOrderId !== workOrderId ||
      gate.projectId !== projectId
    ) {
      return { ok: false, reason: `rejected or mismatched system gate (${path})` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `invalid system gate (${path})` };
  }
}

function reconcileDelegatedRepairQueue(input: {
  coordinator: RepairCoordinator;
  ledger: DailyTaskLedger;
  delegatedTaskId: string;
  now: number;
  succeeded: boolean;
}): void {
  for (const queueRecord of input.coordinator.list()) {
    if (!queueRecord.linkedTaskIds.includes(input.delegatedTaskId)) continue;
    const originals = queueRecord.linkedTaskIds
      .filter((taskId) => taskId !== input.delegatedTaskId)
      .map((taskId) => input.ledger.listAll().find((record) => record.taskId === taskId))
      .filter((record): record is NonNullable<typeof record> => record !== undefined)
      .filter(
        (record) =>
          ["failed", "missing", "running-timeout"].includes(record.status) &&
          (record.repairStatus === "pending" || record.repairStatus === "running"),
      );
    if (originals.length === 0) continue;
    if (input.succeeded) {
      for (const original of originals) {
        input.ledger.markRepairStatus(original.taskId, {
          repairStatus: "fixed",
          updatedAt: input.now,
          summary: "Closed from the authoritative successful delegated repair.",
        });
      }
      input.coordinator.markTerminal(queueRecord.id, "fixed", input.now);
    } else {
      for (const original of originals) {
        input.ledger.markRepairStatus(original.taskId, {
          repairStatus: "pending",
          updatedAt: input.now,
          summary: "Delegated repair failed; returned to the repair queue.",
        });
      }
      input.coordinator.releaseToQueue(queueRecord.id, input.now);
    }
  }
}
