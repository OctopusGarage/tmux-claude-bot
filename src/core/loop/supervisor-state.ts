import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "../../shared/utils/atomic-write.js";
import { LOOP_RUN_ARTIFACTS, loopRunArtifactPath, loopRunDir, loopRunsRoot } from "./artifacts.js";
import type { LoopSupervisedRunResult } from "./supervised-runner.js";
import { type LoopWorkOrder, parseSupervisorFinalSummaryFile } from "./work-order.js";

export type LoopSupervisorWorkOrderStateStatus =
  | "dispatching"
  | "queued"
  | "in-flight"
  | "needs-revision"
  | "completed"
  | "failed"
  | "cancelled";

export type LoopSupervisorWorkOrderState = {
  status: LoopSupervisorWorkOrderStateStatus;
  projectId: string;
  runId: string;
  supervisorSession: string;
  scheduledAt: number;
  updatedAt: number;
  resultStatus?: LoopSupervisedRunResult["status"];
  revisionAttempt?: number;
  revisionReasons?: string[];
};

export type UnfinishedLoopSupervisorWorkOrder = {
  workOrder: LoopWorkOrder;
  state: LoopSupervisorWorkOrderState;
  runDir: string;
};

/** Classified WorkOrder views from one durable artifact scan. */
export type LoopSupervisorWorkOrderRegistry = {
  records: UnfinishedLoopSupervisorWorkOrder[];
  unfinished: UnfinishedLoopSupervisorWorkOrder[];
  recoverableFinalSummary: UnfinishedLoopSupervisorWorkOrder[];
  recoverableFailed: UnfinishedLoopSupervisorWorkOrder[];
  abandoned: UnfinishedLoopSupervisorWorkOrder[];
  staleDispatching: UnfinishedLoopSupervisorWorkOrder[];
  terminal: UnfinishedLoopSupervisorWorkOrder[];
};

const TERMINAL_STATES = new Set<LoopSupervisorWorkOrderStateStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const RECOVERABLE_FAILED_RESULTS = new Set<LoopSupervisedRunResult["status"]>([
  "dispatch-failed",
  "dispatch-timeout",
  "invalid-output",
  "supervisor-failed",
]);
export const STALE_DISPATCHING_WORK_ORDER_MS = 5 * 60 * 1000;
const STALE_UNFINISHED_RESERVATION_MS = 12 * 60 * 60 * 1000;
const INVALID_FINAL_SUMMARY_GRACE_MS = 5 * 60 * 1000;

function reportsRoot(): string {
  return loopRunsRoot();
}

function runDirForWorkOrder(workOrder: LoopWorkOrder): string {
  if (workOrder.finalSummaryPath !== undefined) return dirname(workOrder.finalSummaryPath);
  return loopRunDir(workOrder.projectId, workOrder.id);
}

function workOrderPath(runDir: string): string {
  return join(runDir, LOOP_RUN_ARTIFACTS.workOrder);
}

function statePath(runDir: string): string {
  return join(runDir, LOOP_RUN_ARTIFACTS.workOrderState);
}

export function writeLoopSupervisorWorkOrderState(input: {
  workOrder: LoopWorkOrder;
  supervisorSession: string;
  status: LoopSupervisorWorkOrderStateStatus;
  now: number;
  resultStatus?: LoopSupervisedRunResult["status"];
  revisionAttempt?: number;
  revisionReasons?: string[];
}): void {
  const runDir = runDirForWorkOrder(input.workOrder);
  mkdirSync(runDir, { recursive: true });
  writeFileAtomicSync(workOrderPath(runDir), `${JSON.stringify(input.workOrder, null, 2)}\n`);
  const state: LoopSupervisorWorkOrderState = {
    status: input.status,
    projectId: input.workOrder.projectId,
    runId: input.workOrder.id,
    supervisorSession: input.supervisorSession,
    scheduledAt: input.workOrder.scheduledAt,
    updatedAt: input.now,
  };
  if (input.resultStatus !== undefined) state.resultStatus = input.resultStatus;
  if (input.revisionAttempt !== undefined) state.revisionAttempt = input.revisionAttempt;
  if (input.revisionReasons !== undefined) state.revisionReasons = input.revisionReasons;
  writeFileAtomicSync(statePath(runDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function workOrderStateForResult(
  result: LoopSupervisedRunResult,
): LoopSupervisorWorkOrderStateStatus {
  if (result.status === "cancelled") return "cancelled";
  return result.status === "completed" ? "completed" : "failed";
}

function parseState(value: unknown): LoopSupervisorWorkOrderState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<LoopSupervisorWorkOrderState>;
  if (
    typeof record.status !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.supervisorSession !== "string" ||
    typeof record.scheduledAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return null;
  }
  if (
    ![
      "dispatching",
      "queued",
      "in-flight",
      "needs-revision",
      "completed",
      "failed",
      "cancelled",
    ].includes(record.status)
  ) {
    return null;
  }
  return {
    status: record.status,
    projectId: record.projectId,
    runId: record.runId,
    supervisorSession: record.supervisorSession,
    scheduledAt: record.scheduledAt,
    updatedAt: record.updatedAt,
    ...(typeof record.resultStatus === "string" ? { resultStatus: record.resultStatus } : {}),
    ...(typeof record.revisionAttempt === "number"
      ? { revisionAttempt: record.revisionAttempt }
      : {}),
    ...(Array.isArray(record.revisionReasons) &&
    record.revisionReasons.every((reason) => typeof reason === "string")
      ? { revisionReasons: record.revisionReasons }
      : {}),
  };
}

function parseWorkOrder(value: unknown): LoopWorkOrder | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<LoopWorkOrder>;
  if (
    typeof record.id !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.projectName !== "string" ||
    typeof record.projectPath !== "string" ||
    typeof record.scheduledAt !== "number" ||
    typeof record.requiredFinalMarker !== "string"
  ) {
    return null;
  }
  return record as LoopWorkOrder;
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function listUnfinishedLoopSupervisorWorkOrders(): UnfinishedLoopSupervisorWorkOrder[] {
  return readLoopSupervisorWorkOrderRegistry().unfinished;
}

export function listRecoverableFailedLoopSupervisorWorkOrders(): UnfinishedLoopSupervisorWorkOrder[] {
  return readLoopSupervisorWorkOrderRegistry().recoverableFailed;
}

export function listRecoverableFinalSummaryLoopSupervisorWorkOrders(): UnfinishedLoopSupervisorWorkOrder[] {
  return readLoopSupervisorWorkOrderRegistry().recoverableFinalSummary;
}

export function listAbandonedLoopSupervisorWorkOrders(): UnfinishedLoopSupervisorWorkOrder[] {
  return readLoopSupervisorWorkOrderRegistry().abandoned;
}

export function listStaleDispatchingLoopSupervisorWorkOrders(
  now = Date.now(),
): UnfinishedLoopSupervisorWorkOrder[] {
  return readLoopSupervisorWorkOrderRegistry(now).staleDispatching;
}

export function listTerminalLoopSupervisorWorkOrders(): UnfinishedLoopSupervisorWorkOrder[] {
  return readLoopSupervisorWorkOrderRegistry().terminal;
}

/**
 * Read durable WorkOrder artifacts once and expose domain lifecycle views.
 * The file layout, JSON tolerance, lease lookup, and time policies remain
 * implementation details of this registry module.
 */
export function readLoopSupervisorWorkOrderRegistry(
  now = Date.now(),
): LoopSupervisorWorkOrderRegistry {
  const records = readLoopSupervisorWorkOrderRecords();
  const terminal = records.filter(({ state }) => TERMINAL_STATES.has(state.status));
  const nonTerminal = records.filter(({ state }) => !TERMINAL_STATES.has(state.status));
  return {
    records,
    terminal,
    unfinished: nonTerminal.filter(({ state, workOrder }) =>
      unfinishedWorkOrderCanStillProgress(state, workOrder, now),
    ),
    recoverableFinalSummary: nonTerminal.filter(
      ({ workOrder }) => parseSupervisorFinalSummaryFile(workOrder).ok,
    ),
    recoverableFailed: records.filter(
      ({ state, workOrder }) =>
        state.status === "failed" &&
        state.resultStatus !== undefined &&
        RECOVERABLE_FAILED_RESULTS.has(state.resultStatus) &&
        parseSupervisorFinalSummaryFile(workOrder).ok &&
        !existsSync(loopRunArtifactPath(state.projectId, state.runId, "systemGate")),
    ),
    abandoned: nonTerminal.filter(
      ({ state, workOrder }) => !unfinishedWorkOrderCanStillProgress(state, workOrder, now),
    ),
    staleDispatching: records.filter(
      ({ state }) =>
        state.status === "dispatching" &&
        !hasFinalSummaryFileForState(state) &&
        now - state.updatedAt > STALE_DISPATCHING_WORK_ORDER_MS &&
        now - state.updatedAt <= STALE_UNFINISHED_RESERVATION_MS,
    ),
  };
}

function hasFinalSummaryFileForState(state: LoopSupervisorWorkOrderState): boolean {
  return existsSync(loopRunArtifactPath(state.projectId, state.runId, "supervisorFinalSummary"));
}

function isStaleUnfinishedState(state: LoopSupervisorWorkOrderState, now: number): boolean {
  return now - state.updatedAt > STALE_UNFINISHED_RESERVATION_MS;
}

function unfinishedWorkOrderCanStillProgress(
  state: LoopSupervisorWorkOrderState,
  workOrder: LoopWorkOrder,
  now: number,
): boolean {
  const finalSummaryExists = hasFinalSummaryFileForState(state);
  if (!finalSummaryExists) return !isStaleUnfinishedState(state, now);
  if (parseSupervisorFinalSummaryFile(workOrder).ok) return false;
  return now - state.updatedAt <= INVALID_FINAL_SUMMARY_GRACE_MS;
}

function readLoopSupervisorWorkOrderRecords(): UnfinishedLoopSupervisorWorkOrder[] {
  const root = reportsRoot();
  if (!existsSync(root)) return [];
  const records: UnfinishedLoopSupervisorWorkOrder[] = [];
  for (const projectId of readdirSync(root)) {
    const projectDir = join(root, projectId);
    if (!isDirectory(projectDir)) continue;
    for (const runId of readdirSync(projectDir)) {
      const runDir = join(projectDir, runId);
      if (!isDirectory(runDir)) continue;
      const state = parseState(readJsonFile(statePath(runDir)));
      if (state === null) continue;
      const workOrder = parseWorkOrder(readJsonFile(workOrderPath(runDir)));
      if (workOrder === null) continue;
      records.push({ workOrder, state, runDir });
    }
  }
  return records;
}
