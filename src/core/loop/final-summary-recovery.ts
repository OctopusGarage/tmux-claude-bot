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

export const FINAL_SUMMARY_RECOVERY_TIMEOUT_MS = 2000;
export const FINAL_SUMMARY_RECOVERY_INTERVAL_MS = 100;

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
  const deadline = Date.now() + (options.timeoutMs ?? FINAL_SUMMARY_RECOVERY_TIMEOUT_MS);
  const intervalMs = options.intervalMs ?? FINAL_SUMMARY_RECOVERY_INTERVAL_MS;
  let recovered = recoverInvalidOutputFromFinalSummary(workOrder, result);
  while (recovered.status === "invalid-output" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    recovered = recoverInvalidOutputFromFinalSummary(workOrder, result);
  }
  return recovered;
}
