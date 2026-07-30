import {
  type LoopSupervisorFinalSummary,
  type LoopWorkOrder,
  parseSupervisorFinalSummaryFile,
} from "./work-order.js";

type SupervisorRunStatus =
  | "completed"
  | "blocked"
  | "cancelled"
  | "supervisor-failed"
  | "supervisor-timeout";

type SupervisorRunResult =
  | {
      status: SupervisorRunStatus;
      summary: LoopSupervisorFinalSummary;
      output: string;
    }
  | {
      status: "dispatch-failed" | "dispatch-timeout" | "invalid-output";
      reason: string;
      output: string;
    };

export function supervisorFinalStatusToRunStatus(
  status: LoopSupervisorFinalSummary["status"],
): SupervisorRunStatus {
  if (status === "failed") return "supervisor-failed";
  if (status === "timeout") return "supervisor-timeout";
  return status;
}

export function recoverInvalidOutputFromFinalSummary(
  workOrder: LoopWorkOrder,
  result: SupervisorRunResult,
): SupervisorRunResult {
  if (result.status !== "invalid-output") return result;
  const parsed = parseSupervisorFinalSummaryFile(workOrder);
  if (!parsed.ok) return result;
  return {
    status: supervisorFinalStatusToRunStatus(parsed.summary.status),
    summary: parsed.summary,
    output: [
      result.output,
      `recovered supervisor final summary from ${workOrder.finalSummaryPath ?? "work order state"}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
