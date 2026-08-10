import { existsSync, readFileSync } from "node:fs";
import type {
  LoopSupervisorFinalSummary,
  LoopSupervisorReviewEvidence,
  LoopSupervisorReviewGate,
  LoopSupervisorReviewGateDeterministicGate,
} from "../loop/work-order-contract.js";
import type {
  EvalDeterministicGate,
  EvalLearningCandidates,
  EvalOutcome,
  EvalReport,
} from "./types.js";

export type ParseEvalReportResult =
  | { ok: true; report: EvalReport }
  | { ok: false; reason: "missing-report" | "invalid-report" };

export function buildEvalReportFromSupervisorSummary(input: {
  summary: LoopSupervisorFinalSummary;
  workOrderId?: string;
  taskId?: string;
}): EvalReport {
  const reviewGate = input.summary.reviewGate;
  return {
    schemaVersion: 1,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    source: {
      kind: "work-order-final-summary",
      ...(input.workOrderId !== undefined ? { workOrderId: input.workOrderId } : {}),
      projectId: input.summary.projectId,
    },
    executionBoundary: "worker-internal",
    outcome: evalOutcomeForSummary(input.summary),
    evidence: reviewGate?.evidence ?? [],
    deterministicGates: summarizeDeterministicGates(reviewGate?.deterministicGates ?? []),
    notes: reviewGate?.notes ?? [],
    learningCandidates: learningCandidatesForSummary(input.summary),
  };
}

export function readEvalReportFile(path: string | undefined): ParseEvalReportResult {
  if (path === undefined || !existsSync(path)) return { ok: false, reason: "missing-report" };
  try {
    return parseEvalReport(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return { ok: false, reason: "invalid-report" };
  }
}

export function parseEvalReport(value: unknown): ParseEvalReportResult {
  if (!isRecord(value)) return { ok: false, reason: "invalid-report" };
  if (value.schemaVersion !== 1) return { ok: false, reason: "invalid-report" };
  if (value.executionBoundary !== "worker-internal") {
    return { ok: false, reason: "invalid-report" };
  }
  const taskId = optionalString(value.taskId);
  const source = parseEvalSource(value.source);
  const outcome = parseEvalOutcome(value.outcome);
  const evidence = parseReviewEvidenceList(value.evidence);
  const deterministicGates = parseEvalDeterministicGates(value.deterministicGates);
  const notes = parseStringArray(value.notes);
  const learningCandidates = parseLearningCandidates(value.learningCandidates);
  if (
    taskId === null ||
    source === null ||
    outcome === null ||
    evidence === null ||
    deterministicGates === null ||
    notes === null ||
    learningCandidates === null
  ) {
    return { ok: false, reason: "invalid-report" };
  }
  return {
    ok: true,
    report: {
      schemaVersion: 1,
      ...(taskId !== undefined ? { taskId } : {}),
      source,
      executionBoundary: "worker-internal",
      outcome,
      evidence,
      deterministicGates,
      notes,
      learningCandidates,
    },
  };
}

export function summarizeDeterministicGates(
  gates: LoopSupervisorReviewGateDeterministicGate[],
): EvalDeterministicGate[] {
  return gates.map((gate) => {
    if (typeof gate === "string") {
      return { name: gate, result: "passed" };
    }
    return {
      name: gate.name,
      result: gate.result,
      ...(gate.command !== undefined ? { command: gate.command } : {}),
      ...(gate.evidence !== undefined ? { evidence: gate.evidence } : {}),
    };
  });
}

export function isPreMutationDependencyGate(
  gate: LoopSupervisorReviewGateDeterministicGate,
): boolean {
  if (typeof gate === "string") return false;
  if (gate.result !== "failed") return false;
  const normalized = [gate.name, gate.command, gate.evidence]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return (
    normalized.includes("preflight") &&
    /\bbefore[\s_-]+repair\b/.test(normalized) &&
    (normalized.includes("node_modules") ||
      normalized.includes("local node") ||
      normalized.includes("tool binaries") ||
      normalized.includes(".venv") ||
      normalized.includes("venv") ||
      normalized.includes("vendor/bin"))
  );
}

function evalOutcomeForSummary(summary: LoopSupervisorFinalSummary): EvalOutcome {
  const reviewDecision = summary.reviewGate?.decision;
  const failedGate = hasUnresolvedFailedDeterministicGate(
    summary.reviewGate?.deterministicGates ?? [],
  );
  if (failedGate === true) {
    return baseOutcome(summary, reviewDecision, "failed", "deterministic-gate-failed");
  }
  if (reviewDecision === "fail") {
    return baseOutcome(summary, reviewDecision, "failed", "review-gate-failed");
  }
  if (reviewDecision === "block") {
    return baseOutcome(summary, reviewDecision, "blocked", "review-gate-blocked");
  }
  if (summary.finalVerification === "failed" || summary.status === "failed") {
    return baseOutcome(summary, reviewDecision, "failed", "final-verification-failed");
  }
  if (summary.status === "blocked") {
    return baseOutcome(summary, reviewDecision, "blocked", "supervisor-blocked");
  }
  if (summary.finalVerification === "not-run") {
    return baseOutcome(summary, reviewDecision, "not-run", "verification-not-run");
  }
  if (summary.status === "completed" && summary.finalVerification === "passed") {
    return baseOutcome(summary, reviewDecision, "passed");
  }
  return baseOutcome(summary, reviewDecision, "unknown", "insufficient-eval-signal");
}

function hasUnresolvedFailedDeterministicGate(
  gates: LoopSupervisorReviewGateDeterministicGate[],
): boolean {
  return gates.some(
    (gate, index) =>
      typeof gate !== "string" &&
      gate.result === "failed" &&
      !isPreMutationDependencyGate(gate) &&
      !isResolvedPreflightRepairObservation(gates, index),
  );
}

function isResolvedPreflightRepairObservation(
  gates: LoopSupervisorReviewGateDeterministicGate[],
  failedGateIndex: number,
): boolean {
  const failedGate = gates[failedGateIndex];
  if (failedGate === undefined) return false;
  if (typeof failedGate === "string" || failedGate.result !== "failed") return false;
  if (!gateText(failedGate).includes("preflight")) return false;
  const laterPassedGateText = gates
    .slice(failedGateIndex + 1)
    .filter(isPassedStructuredGate)
    .map(gateText);
  return (
    laterPassedGateText.some(isEnvironmentRepairEvidence) &&
    laterPassedGateText.some(isPostRepairPreflightEvidence)
  );
}

function isPassedStructuredGate(
  gate: LoopSupervisorReviewGateDeterministicGate,
): gate is Exclude<LoopSupervisorReviewGateDeterministicGate, string> {
  return typeof gate !== "string" && gate.result === "passed";
}

function gateText(gate: Exclude<LoopSupervisorReviewGateDeterministicGate, string>): string {
  return [gate.name, gate.command, gate.evidence].filter(Boolean).join("\n").toLowerCase();
}

function isEnvironmentRepairEvidence(text: string): boolean {
  return /\b(environment[- ]repair|preflight[- ]repair|npm ci|npm install|uv sync)\b/.test(text);
}

function isPostRepairPreflightEvidence(text: string): boolean {
  return text.includes("preflight") && /\b(after[- ]repair|post[- ]repair)\b/.test(text);
}

function baseOutcome(
  summary: LoopSupervisorFinalSummary,
  reviewDecision: LoopSupervisorReviewGate["decision"] | undefined,
  status: EvalOutcome["status"],
  reason?: string,
): EvalOutcome {
  return {
    status,
    finalVerification: summary.finalVerification,
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function learningCandidatesForSummary(summary: LoopSupervisorFinalSummary): EvalLearningCandidates {
  return {
    regression: summary.learning?.regressionCandidates ?? [],
    capability: summary.learning?.capabilityEvalCandidates ?? [],
    monitorOrTrace: summary.learning?.monitorOrTraceCandidates ?? [],
    documentation: summary.learning?.documentationCandidates ?? [],
  };
}

function parseEvalSource(value: unknown): EvalReport["source"] | null {
  if (!isRecord(value)) return null;
  const kind = value.kind === "work-order-final-summary" ? value.kind : null;
  const workOrderId = optionalString(value.workOrderId);
  const projectId = stringValue(value.projectId);
  if (kind === null || workOrderId === null || projectId === null) return null;
  return {
    kind,
    ...(workOrderId !== undefined ? { workOrderId } : {}),
    projectId,
  };
}

function parseEvalOutcome(value: unknown): EvalReport["outcome"] | null {
  if (!isRecord(value)) return null;
  const status = parseOneOf(value.status, ["passed", "failed", "blocked", "not-run", "unknown"]);
  const finalVerification = parseOneOf(value.finalVerification, [
    "passed",
    "failed",
    "not-run",
    "unknown",
  ]);
  const reviewDecision = parseOptionalOneOf(value.reviewDecision, ["pass", "block", "fail"]);
  const reason = optionalString(value.reason);
  if (status === null || finalVerification === null || reviewDecision === null || reason === null) {
    return null;
  }
  return {
    status,
    finalVerification,
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function parseEvalDeterministicGates(value: unknown): EvalDeterministicGate[] | null {
  if (!Array.isArray(value)) return null;
  const gates: EvalDeterministicGate[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const name = stringValue(item.name);
    const result = parseOneOf(item.result, ["passed", "failed", "skipped", "not-run"]);
    const command = optionalString(item.command);
    const evidence = optionalString(item.evidence);
    if (name === null || result === null || command === null || evidence === null) return null;
    gates.push({
      name,
      result,
      ...(command !== undefined ? { command } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    });
  }
  return gates;
}

function parseReviewEvidenceList(value: unknown): LoopSupervisorReviewEvidence[] | null {
  if (!Array.isArray(value)) return null;
  const evidence: LoopSupervisorReviewEvidence[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const questionInvestigated = stringValue(item.questionInvestigated);
    const conclusion = stringValue(item.conclusion);
    const itemEvidence = parseStringArray(item.evidence);
    const uncertainty = stringValue(item.uncertainty);
    const recommendedNextStep = stringValue(item.recommendedNextStep);
    if (
      questionInvestigated === null ||
      conclusion === null ||
      itemEvidence === null ||
      uncertainty === null ||
      recommendedNextStep === null
    ) {
      return null;
    }
    evidence.push({
      questionInvestigated,
      conclusion,
      evidence: itemEvidence,
      uncertainty,
      recommendedNextStep,
    });
  }
  return evidence;
}

function parseLearningCandidates(value: unknown): EvalLearningCandidates | null {
  if (!isRecord(value)) return null;
  const regression = parseStringArray(value.regression);
  const capability = parseStringArray(value.capability);
  const monitorOrTrace = parseStringArray(value.monitorOrTrace);
  const documentation = parseStringArray(value.documentation);
  if (
    regression === null ||
    capability === null ||
    monitorOrTrace === null ||
    documentation === null
  ) {
    return null;
  }
  return { regression, capability, monitorOrTrace, documentation };
}

function parseStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

function parseOptionalOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined | null {
  if (value === undefined) return undefined;
  return parseOneOf(value, allowed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
