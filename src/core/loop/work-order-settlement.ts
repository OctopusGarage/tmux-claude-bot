import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import type { LoopWorkOrder } from "./work-order.js";

/** Canonical scheduler identity for a terminal Loop WorkOrder. */
export function loopWorkOrderJobKey(workOrder: LoopWorkOrder): string {
  if (workOrder.task?.kind === "repository-pull-request-review")
    return `pr-review:${workOrder.projectId}`;
  if (workOrder.task?.kind === "workspace-architecture")
    return `workspace:${workOrder.projectId}:architecture`;
  if (workOrder.task?.kind === "pull-request-review")
    return `${workOrder.projectId}:pull-request-review`;
  if (workOrder.task?.kind === "bug-fix") return `${workOrder.projectId}:bug-fix`;
  if (workOrder.task?.kind === "test-coverage") return `${workOrder.projectId}:test-coverage`;
  if (workOrder.task?.kind === "security-maintenance")
    return `${workOrder.projectId}:security-maintenance`;
  if (workOrder.task?.kind === "harness-auto") {
    return workOrder.workspace === undefined
      ? `${workOrder.projectId}:harness-auto`
      : `workspace:${workOrder.projectId}:harness-auto`;
  }
  if (workOrder.task?.kind === "opportunity-discovery") {
    return workOrder.workspace === undefined
      ? `${workOrder.projectId}:opportunity-discovery`
      : `workspace:${workOrder.projectId}:opportunity-discovery`;
  }
  if (workOrder.task?.kind === "automation-governance-review")
    return `${workOrder.projectId}:automation-governance-review`;
  return workOrder.projectId;
}

export function loopLedgerTaskId(workOrder: LoopWorkOrder): string {
  return `loop:${loopWorkOrderJobKey(workOrder)}:${workOrder.scheduledAt}`;
}

export function workerLeaseOutcome(
  resultStatus: LoopSupervisedRunResult["status"],
  cleanupFailed: boolean,
): "success" | "failure" {
  return resultStatus === "completed" && !cleanupFailed ? "success" : "failure";
}
