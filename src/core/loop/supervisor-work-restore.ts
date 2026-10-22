import { createHash } from "node:crypto";
import type { PersistedMessage, QueuedMessage } from "../command/queue.js";
import {
  claimDelegationAttempt,
  type DelegationAttempt,
  readDelegationAttempt,
  settleDelegationAttempt,
} from "./delegation-attempt.js";
import { parseSupervisorFinalSummaryFile } from "./final-summary-contract.js";
import { readFreshSupervisorFinalSummary } from "./final-summary-freshness.js";
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
  attemptId?: string;
};

export function loopSupervisorControlRestore(
  workOrder: LoopWorkOrder,
  supervisorSession: string,
  queuedAt: number,
  attemptId?: string,
): LoopSupervisorControlRestore {
  return {
    kind: "loop-supervisor",
    workOrder,
    supervisorSession,
    queuedAt,
    ...(attemptId === undefined ? {} : { attemptId }),
  };
}

export function restoredLoopSupervisorMessage(
  persisted: PersistedMessage,
  opts: { now?: () => number } = {},
): QueuedMessage | null {
  const restore = parseLoopSupervisorControlRestore(persisted);
  if (restore === null) return null;
  // A crash can leave the durable queue item behind after the worker has already
  // written its authoritative final summary. Replaying that prompt would turn a
  // completed WorkOrder back into in-flight work and duplicate expensive checks.
  const attempt =
    restore.attemptId === undefined
      ? undefined
      : readDelegationAttempt(restore.workOrder, restore.supervisorSession, restore.attemptId);
  if (attempt !== undefined && attempt.phase !== "prepared") return null;
  if (attempt === undefined && parseSupervisorFinalSummaryFile(restore.workOrder).ok) return null;
  const prepared = attempt?.prepared;
  if (
    prepared !== undefined &&
    prepared.promptHash !== createHash("sha256").update(persisted.text).digest("hex")
  )
    return null;
  let ownsExecution = false;
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
    ...(prepared === undefined
      ? {}
      : {
          doneProbe: (output: string) =>
            readFreshSupervisorFinalSummary(restore.workOrder, prepared.freshness).ok ||
            parseSupervisorFinalSummary(output, restore.workOrder.id).ok,
        }),
    started: () => {
      if (prepared !== undefined) {
        try {
          ownsExecution = claimDelegationAttempt(
            restore.workOrder,
            prepared,
            opts.now?.() ?? Date.now(),
          );
          if (!ownsExecution) return false;
        } catch {
          return false;
        }
      }
      writeLoopSupervisorWorkOrderState({
        workOrder: restore.workOrder,
        supervisorSession: restore.supervisorSession,
        status: "in-flight",
        now: opts.now?.() ?? Date.now(),
      });
      return prepared === undefined ? undefined : true;
    },
    resolve: (output) => {
      if (
        prepared !== undefined &&
        !settleRestoredAttempt(restore, prepared, 0, output, opts.now, ownsExecution)
      )
        return;
      if (prepared === undefined) completeRestoredSupervisorWork(restore, output, opts.now);
    },
    reject: (err) => {
      if (
        prepared !== undefined &&
        !settleRestoredAttempt(restore, prepared, 1, err.message, opts.now, ownsExecution)
      )
        return;
      if (prepared === undefined) failRestoredSupervisorWork(restore, err, opts.now);
    },
  };
}

export function shouldDiscardRestoredLoopSupervisorMessage(persisted: PersistedMessage): boolean {
  const restore = parseLoopSupervisorControlRestore(persisted);
  if (restore === null) return false;
  if (restore.attemptId !== undefined)
    return (
      readDelegationAttempt(restore.workOrder, restore.supervisorSession, restore.attemptId)
        .phase === "settled"
    );
  return parseSupervisorFinalSummaryFile(restore.workOrder).ok;
}

function parseLoopSupervisorControlRestore(
  persisted: PersistedMessage,
): LoopSupervisorControlRestore | null {
  const restore = persisted.controlRestore;
  if (restore?.kind !== "loop-supervisor") return null;
  if (typeof restore.supervisorSession !== "string") return null;
  if (typeof restore.queuedAt !== "number") return null;
  if (
    restore.attemptId !== undefined &&
    (typeof restore.attemptId !== "string" ||
      restore.attemptId !== persisted.id ||
      persisted.sessionName !== restore.supervisorSession)
  )
    return null;
  const workOrder = restore.workOrder;
  if (!isLoopWorkOrder(workOrder)) return null;
  return {
    kind: "loop-supervisor",
    workOrder,
    supervisorSession: restore.supervisorSession,
    queuedAt: restore.queuedAt,
    ...(typeof restore.attemptId === "string" ? { attemptId: restore.attemptId } : {}),
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
  prepared?: DelegationAttempt,
): void {
  const file =
    prepared === undefined
      ? undefined
      : readFreshSupervisorFinalSummary(restore.workOrder, prepared.freshness);
  const parsed =
    file?.ok === true ? file : parseSupervisorFinalSummary(output, restore.workOrder.id);
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

function settleRestoredAttempt(
  restore: LoopSupervisorControlRestore,
  prepared: DelegationAttempt,
  status: number,
  output: string,
  now: (() => number) | undefined,
  ownsExecution: boolean,
): boolean {
  try {
    return settleDelegationAttempt(
      restore.workOrder,
      prepared,
      { status, stdout: status === 0 ? output : "", stderr: status === 0 ? "" : output },
      false,
      now?.() ?? Date.now(),
      ownsExecution,
    );
  } catch {
    // Preserve uncertain history for reconciliation; never publish a terminal report from it.
    return false;
  }
}
