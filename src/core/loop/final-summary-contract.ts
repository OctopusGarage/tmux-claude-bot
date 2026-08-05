import { existsSync, readFileSync } from "node:fs";
import type { LoopSupervisorPlanReview } from "./planning.js";
import type {
  LoopSupervisorFinalSummary,
  LoopSupervisorReviewGate,
  LoopSupervisorReviewGateDeterministicGateObject,
  LoopWorkOrder,
  ParseSupervisorFinalSummaryResult,
  SupervisorFinalStatus,
} from "./work-order-contract.js";

const SUPERVISOR_FINAL_STATUSES = new Set<SupervisorFinalStatus>([
  "completed",
  "failed",
  "blocked",
  "timeout",
  "cancelled",
]);

export const SUPERVISOR_FINAL_STATUS_LIST =
  '"completed", "blocked", "failed", "timeout", "cancelled"';

const FINAL_VERIFICATION_STATUSES = new Set<LoopSupervisorFinalSummary["finalVerification"]>([
  "passed",
  "failed",
  "not-run",
  "unknown",
]);

const REVIEW_GATE_AI_REVIEW_STATUSES = new Set<LoopSupervisorReviewGate["aiReview"]>([
  "passed",
  "failed",
  "not-run",
  "not-applicable",
]);

const REVIEW_GATE_DECISIONS = new Set<LoopSupervisorReviewGate["decision"]>([
  "pass",
  "block",
  "fail",
]);

const REVIEW_GATE_DETERMINISTIC_GATE_RESULTS = new Set<
  LoopSupervisorReviewGateDeterministicGateObject["result"]
>(["passed", "failed", "skipped", "not-run"]);

export function finalMarkerForWorkOrder(workOrderId: string): string {
  return `[LOOP_SUPERVISOR_DONE:${workOrderId}]`;
}

export function parseSupervisorFinalSummaryFile(
  workOrder: LoopWorkOrder,
): ParseSupervisorFinalSummaryResult {
  if (workOrder.finalSummaryPath === undefined || !existsSync(workOrder.finalSummaryPath)) {
    return { ok: false, reason: "missing-final-marker" };
  }
  try {
    const parsed = JSON.parse(readFileSync(workOrder.finalSummaryPath, "utf8")) as unknown;
    const summary = parseSummaryObject(parsed);
    if (summary === null || !validateSupervisorFinalSummaryForWorkOrder(workOrder, summary)) {
      return { ok: false, reason: "invalid-summary" };
    }
    return { ok: true, summary };
  } catch {
    return { ok: false, reason: "invalid-summary" };
  }
}

export function validateSupervisorFinalSummaryForWorkOrder(
  workOrder: LoopWorkOrder,
  summary: LoopSupervisorFinalSummary,
): boolean {
  if (workOrder.planning?.required === true && summary.planReview === undefined) {
    return false;
  }
  return true;
}

export function parseSupervisorFinalSummary(
  output: string,
  workOrderId: string,
): ParseSupervisorFinalSummaryResult {
  const marker = finalMarkerForWorkOrder(workOrderId);
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex === -1) return { ok: false, reason: "missing-final-marker" };

  const rawJson = extractFirstJsonObject(output.slice(markerIndex + marker.length));
  if (rawJson === null) return { ok: false, reason: "invalid-summary" };

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const summary = parseSummaryObject(parsed);
    return summary === null ? { ok: false, reason: "invalid-summary" } : { ok: true, summary };
  } catch {
    return { ok: false, reason: "invalid-summary" };
  }
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

function parseSummaryObject(value: unknown): LoopSupervisorFinalSummary | null {
  if (!isRecord(value)) return null;
  const status = parseSupervisorFinalStatus(value.status);
  const projectId = typeof value.projectId === "string" ? value.projectId : null;
  const actionsTaken = parseActionStrings(value.actionsTaken);
  const delegatedTasks = parseDelegatedTasks(value.delegatedTasks);
  const finalVerification = parseFinalVerification(value.finalVerification, status);
  const reviewGate = value.reviewGate === undefined ? undefined : parseReviewGate(value.reviewGate);
  const planReview = value.planReview === undefined ? undefined : parsePlanReview(value.planReview);
  const commits = parseStringArray(value.commits);
  const followUps = parseStringArray(value.followUps);

  if (
    status === null ||
    projectId === null ||
    actionsTaken === null ||
    delegatedTasks === null ||
    finalVerification === null ||
    reviewGate === null ||
    planReview === null ||
    commits === null ||
    followUps === null
  ) {
    return null;
  }

  return {
    status,
    projectId,
    actionsTaken,
    delegatedTasks,
    finalVerification,
    ...(reviewGate !== undefined ? { reviewGate } : {}),
    ...(planReview !== undefined ? { planReview } : {}),
    commits,
    followUps,
  };
}

function parsePlanReview(value: unknown): LoopSupervisorPlanReview | null {
  if (!isRecord(value)) return null;
  const checklistCompleted = parseChecklistCompleted(value.checklistCompleted);
  const targetScoreMet = parseTargetScoreMet(value.targetScoreMet);
  const stopConditionReached = parseBoolean(value.stopConditionReached);
  const overOptimizationAvoided = parseBoolean(value.overOptimizationAvoided);
  const verificationCompleted = parseBoolean(value.verificationCompleted);
  const remainingRisks = parseStringArrayOrSingleton(value.remainingRisks);
  if (
    checklistCompleted === null ||
    targetScoreMet === null ||
    stopConditionReached === null ||
    overOptimizationAvoided === null ||
    verificationCompleted === null ||
    remainingRisks === null
  ) {
    return null;
  }
  return {
    checklistCompleted,
    targetScoreMet,
    stopConditionReached,
    overOptimizationAvoided,
    verificationCompleted,
    remainingRisks,
  };
}

function parseBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseChecklistCompleted(value: unknown): boolean | null {
  const booleanValue = parseBoolean(value);
  if (booleanValue !== null) return booleanValue;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.length > 0;
}

function parseTargetScoreMet(value: unknown): LoopSupervisorPlanReview["targetScoreMet"] | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "not-applicable" || normalized.startsWith("not-applicable:")
    ? "not-applicable"
    : null;
}

function parseReviewGate(value: unknown): LoopSupervisorReviewGate | null {
  if (!isRecord(value)) return null;
  const preMutationReview = parseStringArray(value.preMutationReview);
  const postMutationReview = parseStringArray(value.postMutationReview);
  const aiReview =
    typeof value.aiReview === "string" &&
    REVIEW_GATE_AI_REVIEW_STATUSES.has(value.aiReview as LoopSupervisorReviewGate["aiReview"])
      ? (value.aiReview as LoopSupervisorReviewGate["aiReview"])
      : null;
  const deterministicGates = parseDeterministicGates(value.deterministicGates);
  const decision =
    typeof value.decision === "string" &&
    REVIEW_GATE_DECISIONS.has(value.decision as LoopSupervisorReviewGate["decision"])
      ? (value.decision as LoopSupervisorReviewGate["decision"])
      : null;
  const notes = parseStringArrayOrSingleton(value.notes);
  if (
    preMutationReview === null ||
    postMutationReview === null ||
    aiReview === null ||
    deterministicGates === null ||
    decision === null ||
    notes === null
  ) {
    return null;
  }
  return {
    preMutationReview,
    postMutationReview,
    aiReview,
    deterministicGates,
    decision,
    notes,
  };
}

function parseDeterministicGates(
  value: unknown,
): LoopSupervisorReviewGate["deterministicGates"] | null {
  if (!Array.isArray(value)) return null;
  const gates: LoopSupervisorReviewGate["deterministicGates"] = [];
  for (const item of value) {
    if (typeof item === "string") {
      gates.push(item);
      continue;
    }
    if (!isRecord(item)) return null;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
    const command =
      typeof item.command === "string" && item.command.trim() ? item.command.trim() : undefined;
    const evidence =
      typeof item.evidence === "string" && item.evidence.trim() ? item.evidence.trim() : undefined;
    const result =
      typeof item.result === "string" &&
      REVIEW_GATE_DETERMINISTIC_GATE_RESULTS.has(
        item.result as LoopSupervisorReviewGateDeterministicGateObject["result"],
      )
        ? (item.result as LoopSupervisorReviewGateDeterministicGateObject["result"])
        : null;
    if (name === null || result === null) return null;
    gates.push({
      name,
      result,
      ...(command !== undefined ? { command } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    });
  }
  return gates;
}

function parseDelegatedTasks(value: unknown): LoopSupervisorFinalSummary["delegatedTasks"] | null {
  if (!Array.isArray(value)) return null;
  const tasks: LoopSupervisorFinalSummary["delegatedTasks"] = [];
  for (const item of value) {
    if (typeof item === "string") {
      tasks.push(item);
      continue;
    }
    if (!isRecord(item)) return null;
    if (typeof item.projectId === "string") {
      const status = typeof item.status === "string" && item.status.trim() ? item.status : null;
      if (status === null) return null;
      tasks.push({ projectId: item.projectId, status });
      continue;
    }
    const description = delegatedTaskRecordDescription(item);
    if (description === null) return null;
    tasks.push(description);
  }
  return tasks;
}

function delegatedTaskRecordDescription(item: Record<string, unknown>): string | null {
  const task = typeof item.task === "string" && item.task.trim() ? item.task.trim() : null;
  const result = typeof item.result === "string" && item.result.trim() ? item.result.trim() : null;
  if (task === null && result === null) return null;

  const prefix = Number.isInteger(item.round) ? `Round ${String(item.round)}: ` : "";
  const taskText = task ?? "Delegated task";
  const resultText = result === null ? "" : ` Result: ${result}`;
  return `${prefix}${taskText}${resultText}`;
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function parseActionStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const actions: string[] = [];
  for (const item of value) {
    const parsed = actionString(item);
    if (parsed === null) return null;
    actions.push(parsed);
  }
  return actions;
}

function actionString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const [key, nested] = entries[0] ?? [];
    if (typeof key !== "string") return null;
    return `${key}: ${describeActionValue(nested)}`;
  }
  return describeActionValue(value);
}

function describeActionValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(describeActionValue).join(", ");
  if (!isRecord(value)) return String(value);
  return Object.entries(value)
    .map(([key, nested]) => `${key}=${describeActionValue(nested)}`)
    .join("; ");
}

function parseStringArrayOrSingleton(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  return parseStringArray(value);
}

function parseSupervisorFinalStatus(value: unknown): SupervisorFinalStatus | null {
  if (typeof value !== "string") return null;
  if (SUPERVISOR_FINAL_STATUSES.has(value as SupervisorFinalStatus)) {
    return value as SupervisorFinalStatus;
  }
  if (value === "passed" || value === "complete") return "completed";
  return null;
}

function parseFinalVerification(
  value: unknown,
  status: SupervisorFinalStatus | null,
): LoopSupervisorFinalSummary["finalVerification"] | null {
  if (
    typeof value === "string" &&
    FINAL_VERIFICATION_STATUSES.has(value as LoopSupervisorFinalSummary["finalVerification"])
  ) {
    return value as LoopSupervisorFinalSummary["finalVerification"];
  }
  if (isRecord(value) && status !== null) {
    if (status === "completed") return "passed";
    if (status === "failed") return "failed";
    return "unknown";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
