import type {
  LoopSupervisorFinalSummary,
  LoopSupervisorReviewEvidence,
  LoopSupervisorReviewGate,
} from "../loop/work-order-contract.js";

export type EvalExecutionBoundary = "worker-internal";

export type EvalOutcomeStatus = "passed" | "failed" | "blocked" | "not-run" | "unknown";

export type EvalSource = {
  kind: "work-order-final-summary";
  workOrderId?: string;
  projectId: string;
};

export type EvalDeterministicGate = {
  name: string;
  result: "passed" | "failed" | "skipped" | "not-run";
  command?: string;
  evidence?: string;
};

export type EvalOutcome = {
  status: EvalOutcomeStatus;
  finalVerification: LoopSupervisorFinalSummary["finalVerification"];
  reviewDecision?: LoopSupervisorReviewGate["decision"];
  reason?: string;
};

export type EvalLearningCandidates = {
  regression: string[];
  capability: string[];
  monitorOrTrace: string[];
  documentation: string[];
};

export type EvalReport = {
  schemaVersion: 1;
  taskId?: string;
  source: EvalSource;
  executionBoundary: EvalExecutionBoundary;
  outcome: EvalOutcome;
  evidence: LoopSupervisorReviewEvidence[];
  deterministicGates: EvalDeterministicGate[];
  notes: string[];
  learningCandidates: EvalLearningCandidates;
};
