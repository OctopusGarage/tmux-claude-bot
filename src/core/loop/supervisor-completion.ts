import { LoopBacklogStore } from "./backlog.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import { writeLoopSupervisorReport } from "./supervisor-report.js";
import type { LoopWorkOrder } from "./work-order.js";

export type LoopSupervisorCompletionInput = {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  startedAt: number;
  endedAt: number;
  result: LoopSupervisedRunResult;
  backlog?: LoopBacklogStore;
};

export type LoopSupervisorCompletion = {
  report: ReturnType<typeof writeLoopSupervisorReport>;
  retrySchedule: boolean;
};

export function completeLoopSupervisorRun(
  input: LoopSupervisorCompletionInput,
): LoopSupervisorCompletion {
  const report = writeLoopSupervisorReport({
    workOrder: input.workOrder,
    supervisorSession: input.supervisorSession,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    result: input.result,
  });
  const summary = "summary" in input.result ? input.result.summary : null;
  if (summary !== null) {
    (input.backlog ?? new LoopBacklogStore()).addFollowUps(
      input.workOrder.projectId,
      summary.followUps,
      input.endedAt,
      report.runId,
    );
  }
  return {
    report,
    retrySchedule: shouldRetrySupervisedSchedule(input.result),
  };
}

function shouldRetrySupervisedSchedule(result: LoopSupervisedRunResult): boolean {
  if (result.status !== "dispatch-failed") return false;
  return [
    "missing loop supervisor session name",
    "missing loop supervisor dispatch adapter",
    "no live loop supervisor session",
    "loop supervisor task queue is full",
    "duplicate loop supervisor task is already queued or running",
    "loop supervisor task was cancelled before enqueue",
    "loop supervisor task was cancelled",
  ].some((reason) => result.reason.includes(reason));
}
