import { existsSync, readFileSync } from "node:fs";
import type { LoopSupervisorPlanReview } from "./planning.js";
import type {
  LoopSupervisorFinalSummary,
  LoopSupervisorLearning,
  LoopSupervisorPullRequestDecision,
  LoopSupervisorPullRequestDecisionOutcome,
  LoopSupervisorPullRequestHumanBoundary,
  LoopSupervisorReviewEvidence,
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

const PULL_REQUEST_OUTCOMES = new Set<LoopSupervisorPullRequestDecisionOutcome>([
  "merged",
  "closed",
  "approved",
  "retry",
  "manual-review",
]);
const PULL_REQUEST_CLOSE_REASONS = new Set(["duplicate", "obsolete", "non-actionable", "invalid"]);
const PULL_REQUEST_HUMAN_BOUNDARIES = new Set<LoopSupervisorPullRequestHumanBoundary>([
  "ownership",
  "protected-branch-policy",
  "product-decision",
  "migration-decision",
  "security-decision",
  "legal-compliance",
  "organization-policy",
]);

export type RepositoryPullRequestReviewDisposition =
  | "completed"
  | "retry"
  | "manual-review"
  | "invalid";

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
    const parsedSummary = parseSummaryObject(parsed);
    const summary =
      parsedSummary === null
        ? null
        : recoverNonTerminalPullRequestDecisions(workOrder, parsedSummary);
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
  if (workOrder.task?.kind === "repository-pull-request-review") {
    const disposition = repositoryPullRequestReviewDisposition(summary);
    if (disposition === "invalid") return false;
    if (summary.status === "completed" && disposition !== "completed") return false;
  }
  return true;
}

/**
 * Recover non-terminal PR decisions when a supervisor wrote explicit decision
 * lines but omitted the structured array. Terminal outcomes are never inferred
 * from prose.
 */
export function recoverNonTerminalPullRequestDecisions(
  workOrder: LoopWorkOrder,
  summary: LoopSupervisorFinalSummary,
): LoopSupervisorFinalSummary {
  if (
    workOrder.task?.kind !== "repository-pull-request-review" ||
    summary.pullRequestDecisions !== undefined
  ) {
    return summary;
  }
  const repository = workOrder.task.repo;

  const decisions = summary.actionsTaken
    .map((action) => {
      const match = action.match(
        /\bPR\s*#(\d+)\b[\s\S]*?\bdecision\s*=\s*(retry|manual-review)\b/i,
      );
      if (match === null) return undefined;
      const number = Number(match[1]);
      const outcome = match[2]?.toLowerCase() as "retry" | "manual-review" | undefined;
      if (!Number.isInteger(number) || outcome === undefined) return undefined;
      const followUp = summary.followUps.find((item) => item.includes(`#${number}`));
      return {
        number,
        repository,
        outcome,
        evidence: [action],
        nextStep: followUp ?? "re-evaluate this pull request on the next retry",
      };
    })
    .filter((decision): decision is NonNullable<typeof decision> => decision !== undefined);

  const uniqueNumbers = new Set(decisions.map((decision) => decision.number));
  if (decisions.length === 0) {
    return summary.actionsTaken.some((action) =>
      provesEmptyPullRequestInventory(action, repository),
    )
      ? { ...summary, pullRequestDecisions: [] }
      : summary;
  }
  if (uniqueNumbers.size !== decisions.length) return summary;
  return { ...summary, pullRequestDecisions: decisions };
}

function provesEmptyPullRequestInventory(action: string, repository: string): boolean {
  const normalized = action.toLowerCase();
  const repo = repository.toLowerCase();
  if (!normalized.includes(repo)) return false;
  return (
    /\b(?:open\s+pr|pull\s+request)\s+(?:inventory|list)\b[\s\S]*\b(?:empty|returned\s+\[\])/i.test(
      action,
    ) ||
    /\b(?:open\s+pr|pull\s+request)\s+count\s*[:=]?\s*(?:0|zero)\b/i.test(action) ||
    /\b(?:0|zero)\s+open\s+pr(?:s|\b)/i.test(action) ||
    /\bgh\s+pr\s+list\b[\s\S]*\breturned\s+\[\]/i.test(action)
  );
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
  const learning = value.learning === undefined ? undefined : parseLearning(value.learning);
  const commits = parseStringArray(value.commits);
  const followUps = parseStringArray(value.followUps);
  const pullRequestDecisions =
    value.pullRequestDecisions === undefined
      ? undefined
      : parsePullRequestDecisions(value.pullRequestDecisions);

  if (
    status === null ||
    projectId === null ||
    actionsTaken === null ||
    delegatedTasks === null ||
    finalVerification === null ||
    reviewGate === null ||
    planReview === null ||
    learning === null ||
    commits === null ||
    followUps === null ||
    pullRequestDecisions === null
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
    ...(learning !== undefined ? { learning } : {}),
    commits,
    followUps,
    ...(pullRequestDecisions !== undefined ? { pullRequestDecisions } : {}),
  };
}

export function repositoryPullRequestReviewDisposition(
  summary: LoopSupervisorFinalSummary,
): RepositoryPullRequestReviewDisposition {
  const decisions = summary.pullRequestDecisions;
  if (decisions === undefined) return "invalid";
  if (
    decisions.some(
      (decision) => decision.outcome === "manual-review" && decision.boundary === undefined,
    )
  ) {
    return "retry";
  }
  if (
    decisions.some(
      (decision) =>
        decision.outcome === "approved" &&
        (decision.reviewedHeadSha === undefined || !isValidHeadSha(decision.reviewedHeadSha)),
    )
  ) {
    return "invalid";
  }
  if (decisions.some((decision) => decision.outcome === "retry")) return "retry";
  if (decisions.some((decision) => decision.outcome === "approved")) return "retry";
  if (decisions.some((decision) => decision.outcome === "manual-review")) {
    return "manual-review";
  }
  return decisions.every(
    (decision) => decision.outcome === "merged" || decision.outcome === "closed",
  )
    ? "completed"
    : "invalid";
}

function parsePullRequestDecisions(value: unknown): LoopSupervisorPullRequestDecision[] | null {
  if (!Array.isArray(value)) return null;
  const decisions: LoopSupervisorPullRequestDecision[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.number) || (item.number as number) < 1)
      return null;
    if (typeof item.repository !== "string" || item.repository.trim() === "") return null;
    if (
      typeof item.outcome !== "string" ||
      !PULL_REQUEST_OUTCOMES.has(item.outcome as LoopSupervisorPullRequestDecisionOutcome)
    ) {
      return null;
    }
    const outcome = item.outcome as LoopSupervisorPullRequestDecisionOutcome;
    const boundary = item.boundary;
    if (
      (boundary !== undefined &&
        (typeof boundary !== "string" ||
          !PULL_REQUEST_HUMAN_BOUNDARIES.has(
            boundary as LoopSupervisorPullRequestHumanBoundary,
          ))) ||
      (outcome !== "manual-review" && boundary !== undefined)
    ) {
      return null;
    }
    const reason = item.reason;
    if (outcome === "closed") {
      if (typeof reason !== "string" || !PULL_REQUEST_CLOSE_REASONS.has(reason)) return null;
    } else if (reason !== undefined && typeof reason !== "string") {
      return null;
    }
    const reviewedHeadSha = item.reviewedHeadSha;
    if (
      outcome === "approved" &&
      (typeof reviewedHeadSha !== "string" || !isValidHeadSha(reviewedHeadSha))
    ) {
      return null;
    }
    if (outcome !== "approved" && reviewedHeadSha !== undefined) return null;
    const evidence = parseStringArrayOrSingleton(item.evidence);
    const nextStep = typeof item.nextStep === "string" ? item.nextStep.trim() : "";
    if (evidence === null || nextStep === "") return null;
    if (
      (outcome === "approved" || outcome === "retry" || outcome === "manual-review") &&
      evidence.length === 0
    ) {
      return null;
    }
    const decision: LoopSupervisorPullRequestDecision = {
      number: item.number as number,
      repository: item.repository.trim(),
      outcome,
      ...(boundary === undefined
        ? {}
        : { boundary: boundary as LoopSupervisorPullRequestHumanBoundary }),
      ...(typeof reviewedHeadSha === "string" ? { reviewedHeadSha } : {}),
      evidence,
      nextStep,
    };
    if (typeof reason === "string") decision.reason = reason as NonNullable<typeof decision.reason>;
    decisions.push(decision);
  }
  return decisions;
}

function isValidHeadSha(value: string): boolean {
  return /^[a-fA-F0-9]{6,64}$/.test(value);
}

function parseLearning(value: unknown): LoopSupervisorLearning | null {
  if (!isRecord(value)) return null;
  const regressionCandidates = parseStringArray(value.regressionCandidates);
  const capabilityEvalCandidates = parseStringArray(value.capabilityEvalCandidates);
  const monitorOrTraceCandidates = parseStringArray(value.monitorOrTraceCandidates);
  const documentationCandidates = parseStringArray(value.documentationCandidates);
  if (
    regressionCandidates === null ||
    capabilityEvalCandidates === null ||
    monitorOrTraceCandidates === null ||
    documentationCandidates === null
  ) {
    return null;
  }
  return {
    regressionCandidates,
    capabilityEvalCandidates,
    monitorOrTraceCandidates,
    documentationCandidates,
  };
}

function parsePlanReview(value: unknown): LoopSupervisorPlanReview | null {
  if (!isRecord(value)) return null;
  const checklistCompleted = parseChecklistCompleted(value.checklistCompleted);
  const targetScoreMet = parseTargetScoreMet(value.targetScoreMet);
  const stopConditionReached = parseStopConditionReached(value.stopConditionReached);
  const overOptimizationAvoided = parseCompletionEvidence(value.overOptimizationAvoided);
  const verificationCompleted = parseCompletionEvidence(value.verificationCompleted);
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

function parseStopConditionReached(value: unknown): boolean | null {
  const booleanValue = parseBoolean(value);
  if (booleanValue !== null) return booleanValue;
  return typeof value === "string" && value.trim() !== "" ? true : null;
}

function parseCompletionEvidence(value: unknown): boolean | null {
  const booleanValue = parseBoolean(value);
  if (booleanValue !== null) return booleanValue;
  if (typeof value === "string") {
    if (/\b(?:skipped|not[- ]run)\b/i.test(value)) return false;
    return value.trim() !== "" ? true : null;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.length > 0;
}

function parseChecklistCompleted(value: unknown): boolean | null {
  const booleanValue = parseBoolean(value);
  if (booleanValue !== null) return booleanValue;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value.length > 0;
}

function parseTargetScoreMet(value: unknown): LoopSupervisorPlanReview["targetScoreMet"] | null {
  if (typeof value === "boolean") return value;
  if (value === "not-applicable") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (/^not[- ]applicable\b/.test(normalized)) return "not-applicable";
  if (/^(?:yes|met|passed|true)\b/.test(normalized)) return true;
  if (/^(?:no|not[- ]met|failed|false)\b/.test(normalized)) return false;
  return null;
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
  const notes = parseReviewNotes(value.notes);
  const evidence =
    value.evidence === undefined ? undefined : parseReviewEvidenceList(value.evidence);
  if (
    preMutationReview === null ||
    postMutationReview === null ||
    aiReview === null ||
    deterministicGates === null ||
    decision === null ||
    notes === null ||
    evidence === null
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
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

function parseReviewEvidenceList(value: unknown): LoopSupervisorReviewEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const evidence: LoopSupervisorReviewEvidence[] = [];
  for (const item of value) {
    const parsed = parseReviewEvidence(item);
    if (parsed === null) return null;
    evidence.push(parsed);
  }
  return evidence;
}

function parseReviewEvidence(value: unknown): LoopSupervisorReviewEvidence | null {
  if (!isRecord(value)) return null;
  const questionInvestigated =
    typeof value.questionInvestigated === "string" ? value.questionInvestigated : null;
  const conclusion = typeof value.conclusion === "string" ? value.conclusion : null;
  const evidence = parseStringArrayOrSingleton(value.evidence);
  const uncertainty = typeof value.uncertainty === "string" ? value.uncertainty : null;
  const recommendedNextStep =
    typeof value.recommendedNextStep === "string" ? value.recommendedNextStep : null;
  if (
    questionInvestigated === null ||
    conclusion === null ||
    evidence === null ||
    uncertainty === null ||
    recommendedNextStep === null
  ) {
    return null;
  }
  return {
    questionInvestigated,
    conclusion,
    evidence,
    uncertainty,
    recommendedNextStep,
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

function parseReviewNotes(value: unknown): string[] | null {
  if (isRecord(value)) return [describeActionValue(value)];
  return parseStringArrayOrSingleton(value);
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
