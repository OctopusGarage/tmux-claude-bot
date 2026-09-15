import { readCurrentDelegationAttempt } from "./delegation-attempt.js";
import { parseSupervisorFinalSummaryJson } from "./final-summary-contract.js";
import { supervisorFinalStatusToRunStatus } from "./final-summary-recovery.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import type { LoopWorkOrder } from "./work-order-contract.js";

type Recovery =
  | { kind: "legacy" | "pending" }
  | {
      kind: "settled";
      attemptId: string;
      supervisorSession: string;
      result: LoopSupervisedRunResult;
    };

/** Frozen transport evidence is a candidate for the normal system gate, never acceptance. */
export function readDelegationRecovery(workOrder: LoopWorkOrder): Recovery {
  const attempt = readCurrentDelegationAttempt(workOrder);
  if (attempt.phase === "absent") return { kind: "legacy" };
  if (attempt.phase !== "settled") return { kind: "pending" };
  const { settled, prepared } = attempt;
  const candidate = (result: LoopSupervisedRunResult): Recovery => ({
    kind: "settled",
    attemptId: prepared.attemptId,
    supervisorSession: prepared.supervisorSession,
    result,
  });
  if (settled.cancelled)
    return candidate({
      status: "cancelled",
      summary: {
        status: "cancelled",
        projectId: workOrder.projectId,
        actionsTaken: ["Delegation transport was cancelled."],
        delegatedTasks: [],
        finalVerification: "not-run",
        commits: [],
        followUps: [],
      },
      output: settled.output,
      finalSummaryRecovery: "disabled",
    });
  if (settled.status !== 0)
    return candidate({
      status: "dispatch-failed",
      reason: settled.output || "delegation transport failed",
      output: settled.output,
      finalSummaryRecovery: "disabled",
    });
  try {
    const snapshot: unknown = JSON.parse(settled.finalSummary);
    if (
      typeof snapshot === "object" &&
      snapshot !== null &&
      "ok" in snapshot &&
      snapshot.ok === true &&
      "summary" in snapshot
    ) {
      const parsed = parseSupervisorFinalSummaryJson(workOrder, JSON.stringify(snapshot.summary));
      if (parsed.ok)
        return candidate({
          status: supervisorFinalStatusToRunStatus(parsed.summary.status),
          summary: parsed.summary,
          output: settled.output,
        });
    }
  } catch {
    // A later mutable summary must not replace missing or corrupt settlement evidence.
  }
  return candidate({
    status: "invalid-output",
    reason: "settled delegation attempt has no valid final summary",
    output: settled.output,
    finalSummaryRecovery: "disabled",
  });
}
