import type { DailyTaskLedger } from "../tasks/task-ledger.js";
import type { LoopSchedulerStore } from "./scheduler.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import type { LoopSupervisorWorkOrderStateStatus } from "./supervisor-state.js";
import type { LoopWorkOrder } from "./work-order.js";
import { loopLedgerTaskId, loopWorkOrderJobKey } from "./work-order-settlement.js";

type OutcomeDependencies = {
  writeState: (input: {
    workOrder: LoopWorkOrder;
    supervisorSession: string;
    status: LoopSupervisorWorkOrderStateStatus;
    now: number;
    resultStatus: LoopSupervisedRunResult["status"];
  }) => void;
  settleLease: (
    workOrder: LoopWorkOrder,
    resultStatus: LoopSupervisedRunResult["status"],
    now: number,
  ) => void;
  scheduler: Pick<LoopSchedulerStore, "setLastFired">;
  ledger: Pick<DailyTaskLedger, "expect" | "start" | "finish" | "fail">;
};

export type SupervisorWorkOrderOutcome = OutcomeDependencies & {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  startedAt: number;
  endedAt: number;
  resultStatus: LoopSupervisedRunResult["status"];
  stateStatus: LoopSupervisorWorkOrderStateStatus;
  reportPath: string;
  summary?: string;
  failureSummary?: string;
  advanceScheduler: boolean;
  skipLedger?: boolean;
};

/** Persist every durable consequence of one terminal supervisor WorkOrder outcome. */
export function settleSupervisorWorkOrderOutcome(input: SupervisorWorkOrderOutcome): void {
  const ledgerTaskId = loopLedgerTaskId(input.workOrder);
  input.writeState({
    workOrder: input.workOrder,
    supervisorSession: input.supervisorSession,
    status: input.stateStatus,
    now: input.endedAt,
    resultStatus: input.resultStatus,
  });
  input.settleLease(input.workOrder, input.resultStatus, input.endedAt);
  if (input.advanceScheduler)
    input.scheduler.setLastFired(loopWorkOrderJobKey(input.workOrder), input.workOrder.scheduledAt);
  if (input.skipLedger) return;
  input.ledger.expect({
    taskId: ledgerTaskId,
    source: "loop-engineering",
    name: `${input.workOrder.projectId} ${input.workOrder.task?.kind ?? "architecture"}`,
    scheduledAt: input.workOrder.scheduledAt,
  });
  input.ledger.start(ledgerTaskId, input.startedAt);
  if (input.resultStatus === "completed") {
    input.ledger.finish(ledgerTaskId, {
      endedAt: input.endedAt,
      summary: input.summary ?? input.resultStatus,
      reportPath: input.reportPath,
    });
    return;
  }
  input.ledger.fail(ledgerTaskId, {
    endedAt: input.endedAt,
    error: input.resultStatus,
    summary: input.failureSummary ?? "Loop supervisor run did not complete successfully.",
    reportPath: input.reportPath,
  });
}
