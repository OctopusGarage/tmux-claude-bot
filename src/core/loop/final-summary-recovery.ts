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

export async function recoverInvalidOutputFromFinalSummaryAsync(
  workOrder: LoopWorkOrder,
  result: SupervisorRunResult,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SupervisorRunResult> {
  if (result.status !== "invalid-output") return result;
  const deadline = Date.now() + (options.timeoutMs ?? 1000);
  const intervalMs = options.intervalMs ?? 50;
  let recovered = recoverInvalidOutputFromFinalSummary(workOrder, result);
  while (recovered.status === "invalid-output" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    recovered = recoverInvalidOutputFromFinalSummary(workOrder, result);
  }
  return recovered;
}
