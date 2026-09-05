import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readLoopSupervisorWorkerLeaseState,
  releaseLoopSupervisorWorker,
  writeLoopSupervisorWorkerLeaseState,
} from "../loop/supervisor-pool.js";
import {
  listRecoverableFinalSummaryLoopSupervisorWorkOrders,
  listTerminalLoopSupervisorWorkOrders,
  writeLoopSupervisorWorkOrderState,
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
  const terminalWorkOrders = listTerminalLoopSupervisorWorkOrders();
  const terminalRunIds = new Set(terminalWorkOrders.map((record) => record.workOrder.id));
  const actionableByRunId = new Map(
    [...terminalWorkOrders, ...listRecoverableFinalSummaryLoopSupervisorWorkOrders()].map(
      (record) => [record.workOrder.id, record],
    ),
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
    const actionable = actionableByRunId.get(runId);
    if (actionable === undefined) continue;

    const summary = parseSupervisorFinalSummaryFile(actionable.workOrder);
    const gatePath = join(actionable.runDir, "system-gate.json");
    const gate = readAcceptedSystemGate(
      gatePath,
      actionable.workOrder.id,
      actionable.workOrder.projectId,
    );
    if (!terminalRunIds.has(runId) && !gate.ok) continue;
    result.checked += 1;
    const recoveredSuccessfully = summary.ok && summary.summary.status === "completed" && gate.ok;
    if (recoveredSuccessfully) {
      if (!terminalRunIds.has(runId)) {
        settleRecoveredFinalSummaryWorkOrder(actionable, now);
      }
      ledger.finish(task.taskId, {
        endedAt: now,
        summary: "Reconciled from terminal supervisor artifacts.",
        reportPath: actionable.runDir,
      });
      reconcileDelegatedRepairQueue({
        coordinator,
        ledger,
        delegatedTaskId: task.taskId,
        now,
        succeeded: true,
      });
      reconcileOperatorEquivalentSelfHealQueue({
        coordinator,
        ledger,
        delegatedTaskId: task.taskId,
        now,
        requirement: workOrderRequirement(actionable.workOrder),
        projectId: actionable.workOrder.projectId,
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
        reportPath: actionable.runDir,
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

    if (input.cleanupWorkerSession !== undefined && actionable.workOrder.workerSession) {
      try {
        await input.cleanupWorkerSession(actionable.workOrder.workerSession);
        result.cleaned += 1;
      } catch {
        // Ledger closure remains durable; the next guardian tick can retry cleanup.
      }
    }
  }

  return result;
}

function settleRecoveredFinalSummaryWorkOrder(
  actionable: ReturnType<typeof listRecoverableFinalSummaryLoopSupervisorWorkOrders>[number],
  now: number,
): void {
  writeLoopSupervisorWorkOrderState({
    workOrder: actionable.workOrder,
    supervisorSession: actionable.state.supervisorSession,
    status: "completed",
    now,
    resultStatus: "completed",
  });
  writeLoopSupervisorWorkerLeaseState(
    releaseLoopSupervisorWorker({
      state: readLoopSupervisorWorkerLeaseState(),
      workOrderId: actionable.workOrder.id,
      result: "success",
      now,
      retainFailureForMs:
        (actionable.workOrder.executionIsolation?.cleanup.retainFailureForHours ?? 72) *
        60 *
        60 *
        1000,
    }),
  );
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

function reconcileOperatorEquivalentSelfHealQueue(input: {
  coordinator: RepairCoordinator;
  ledger: DailyTaskLedger;
  delegatedTaskId: string;
  now: number;
  requirement: string;
  projectId: string;
}): void {
  if (input.projectId !== "tmux-claude-bot") return;
  if (!isOperatorEquivalentSelfHealRequirement(input.requirement)) return;
  for (const queueRecord of input.coordinator.list()) {
    if (queueRecord.projectId !== "tmux-claude-bot") continue;
    if (queueRecord.source !== "system-self-heal") continue;
    if (!["pending", "leased", "running", "retry-wait"].includes(queueRecord.status)) continue;
    input.coordinator.linkTaskIds(queueRecord.id, [input.delegatedTaskId], input.now);
    for (const taskId of queueRecord.linkedTaskIds) {
      input.ledger.markRepairStatus(taskId, {
        repairStatus: "fixed",
        updatedAt: input.now,
        summary:
          "Closed from the authoritative successful operator-equivalent self-heal delegation.",
      });
    }
    input.coordinator.markTerminal(queueRecord.id, "fixed", input.now);
  }
}

function isOperatorEquivalentSelfHealRequirement(requirement: string): boolean {
  const normalized = requirement.toLowerCase();
  return (
    normalized.includes("operator-equivalent investigation") &&
    normalized.includes("automation task") &&
    normalized.includes("last 24 hours")
  );
}

function workOrderRequirement(workOrder: unknown): string {
  if (workOrder === null || typeof workOrder !== "object") return "";
  if (!("task" in workOrder)) return "";
  const task = workOrder.task;
  if (task === null || typeof task !== "object") return "";
  if (!("requirement" in task)) return "";
  return typeof task.requirement === "string" ? task.requirement : "";
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
