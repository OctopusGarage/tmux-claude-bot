import type { PersistedMessage, QueuedMessage } from "../command/queue.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import { completeLoopSupervisorRun } from "./supervisor-completion.js";
import { workOrderStateForResult, writeLoopSupervisorWorkOrderState } from "./supervisor-state.js";
import {
  type LoopSupervisorFinalSummary,
  type LoopWorkOrder,
  parseSupervisorFinalSummary,
} from "./work-order.js";

export type LoopSupervisorControlRestore = {
  kind: "loop-supervisor";
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  queuedAt: number;
};

export function loopSupervisorControlRestore(
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  queuedAt: number,
): LoopSupervisorControlRestore {
  return {
    kind: "loop-supervisor",
    workOrder,
    supervisorSession,
    queuedAt,
  };
}

export function restoredLoopSupervisorMessage(
  persisted: PersistedMessage,
  opts: { now?: () => number } = {},
): QueuedMessage | null {
  const restore = parseLoopSupervisorControlRestore(persisted);
  if (restore === null) return null;
  return {
    id: persisted.id,
    text: persisted.text,
    chatId: persisted.chatId,
    channel: "control",
    sessionName: persisted.sessionName,
    action: persisted.action,
    origin: persisted.origin,
    promptSource: persisted.promptSource,
    sourceText: persisted.sourceText,
    transform: persisted.transform,
    traceId: persisted.traceId,
    controlRestore: persisted.controlRestore,
    started: () =>
      writeLoopSupervisorWorkOrderState({
        workOrder: restore.workOrder,
        supervisorSession: restore.supervisorSession,
        status: "in-flight",
        now: opts.now?.() ?? Date.now(),
      }),
    resolve: (output) => completeRestoredSupervisorWork(restore, output, opts.now),
    reject: (err) => failRestoredSupervisorWork(restore, err, opts.now),
  };
}

function parseLoopSupervisorControlRestore(
  persisted: PersistedMessage,
): LoopSupervisorControlRestore | null {
  const restore = persisted.controlRestore;
  if (restore?.kind !== "loop-supervisor") return null;
  if (typeof restore.supervisorSession !== "string") return null;
  if (typeof restore.queuedAt !== "number") return null;
  const workOrder = restore.workOrder;
  if (!isLoopWorkOrder(workOrder)) return null;
  return {
    kind: "loop-supervisor",
    workOrder,
    supervisorSession: restore.supervisorSession,
    queuedAt: restore.queuedAt,
  };
}

function isLoopWorkOrder(value: unknown): value is LoopWorkOrder {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { projectId?: unknown }).projectId === "string" &&
    typeof (value as { projectName?: unknown }).projectName === "string" &&
    typeof (value as { projectPath?: unknown }).projectPath === "string" &&
    typeof (value as { requiredFinalMarker?: unknown }).requiredFinalMarker === "string"
  );
}

function completeRestoredSupervisorWork(
  restore: LoopSupervisorControlRestore,
  output: string,
  now: (() => number) | undefined,
): void {
  const parsed = parseSupervisorFinalSummary(output, restore.workOrder.id);
  const result: LoopSupervisedRunResult = parsed.ok
    ? {
        status: mapRestoredSupervisorStatus(parsed.summary.status),
        summary: parsed.summary,
        output,
      }
    : {
        status: "invalid-output",
        reason: parsed.reason,
        output,
      };
  writeRestoredSupervisorReport(restore, result, now);
}

function failRestoredSupervisorWork(
  restore: LoopSupervisorControlRestore,
  err: Error,
  now: (() => number) | undefined,
): void {
  writeRestoredSupervisorReport(
    restore,
    {
      status: "dispatch-failed",
      reason: err.message,
      output: err.message,
    },
    now,
  );
}

function writeRestoredSupervisorReport(
  restore: LoopSupervisorControlRestore,
  result: LoopSupervisedRunResult,
  now: (() => number) | undefined,
): void {
  const endedAt = now?.() ?? Date.now();
  completeLoopSupervisorRun({
    workOrder: restore.workOrder,
    supervisorSession: restore.supervisorSession,
    startedAt: restore.queuedAt,
    endedAt,
    result,
  });
  writeLoopSupervisorWorkOrderState({
    workOrder: restore.workOrder,
    supervisorSession: restore.supervisorSession,
    status: workOrderStateForResult(result),
    now: endedAt,
    resultStatus: result.status,
  });
}

function mapRestoredSupervisorStatus(
  status: LoopSupervisorFinalSummary["status"],
): Exclude<
  LoopSupervisedRunResult["status"],
  "dispatch-failed" | "dispatch-timeout" | "invalid-output"
> {
  if (status === "failed") return "supervisor-failed";
  if (status === "timeout") return "supervisor-timeout";
  return status;
}
