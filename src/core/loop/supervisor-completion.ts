import { classifyAgentTransientFailure } from "../agents/transient-failure.js";
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

export type LoopSupervisorScheduleRetryKind =
  | "supervisor-dispatch-unavailable"
  | "agent-transient-failure"
  | "supervisor-output-contract"
  | "not-retryable";

export type LoopSupervisorScheduleRetry = {
  retrySchedule: boolean;
  kind: LoopSupervisorScheduleRetryKind;
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
    retrySchedule: classifyLoopSupervisorScheduleRetry(input.result).retrySchedule,
  };
}

export function classifyLoopSupervisorScheduleRetry(
  result: LoopSupervisedRunResult,
): LoopSupervisorScheduleRetry {
  if (result.status === "invalid-output") {
    return { retrySchedule: true, kind: "supervisor-output-contract" };
  }
  if (result.status !== "dispatch-failed") return { retrySchedule: false, kind: "not-retryable" };
  const retryDispatch = [
    "missing loop supervisor session name",
    "missing loop supervisor dispatch adapter",
    "did not become ready in time",
    "no live loop supervisor session",
    "loop supervisor task queue is full",
    "loop supervisor worker did not consume queued task before deadline",
    "duplicate loop supervisor task is already queued or running",
    "loop supervisor task was cancelled before enqueue",
    "loop supervisor task was cancelled",
  ].some((reason) => result.reason.includes(reason));
  if (retryDispatch) {
    return { retrySchedule: true, kind: "supervisor-dispatch-unavailable" };
  }
  if (classifyAgentTransientFailure(`${result.reason}\n${result.output}`) !== null) {
    return { retrySchedule: true, kind: "agent-transient-failure" };
  }
  return { retrySchedule: false, kind: "not-retryable" };
}
